import { createServerFn } from "@tanstack/react-start";
import { env } from "cloudflare:workers";
import { z } from "zod";
import { assertOrgPermission } from "@/lib/org-access";
import { getPrisma } from "@/lib/db";
import { idSchema, labelSchema, parseOrThrow, textSchema } from "@/lib/validation";
import { isValidTimecode, parseTimecodeString, timecodeToFrames } from "@/lib/timecode";
import type { FrameRate, TimecodeFormat } from "@/types/timecode";
import { isBridgeVersionAtLeast } from "@/lib/bridge-version";

const songIdInput = z.object({ orgId: idSchema, songId: idSchema });
const metadataSchema = z.object({
  orgId: idSchema,
  songId: idSchema.optional(),
  title: labelSchema,
  artist: z.string().trim().max(200).default(""),
  ccliNumber: z.string().trim().max(80).default(""),
  bpm: z.number().int().min(1).max(400).nullable().default(null),
  keySignature: z.string().trim().max(20).default(""),
});

const createSongSchema = metadataSchema.omit({ songId: true }).extend({
  sections: z.array(z.object({
    label: z.string().trim().min(1, "Section name is required.").max(200),
    lyrics: z.string().trim().min(1, "Section lyrics are required.").max(10_000),
  })).min(1, "Add at least one lyric section.").max(100),
});

const sectionSchema = z.object({
  orgId: idSchema,
  songId: idSchema,
  sectionId: idSchema.optional(),
  label: labelSchema,
  lyrics: textSchema,
  sourceSlideIndex: z.number().int().min(0).nullable().optional(),
});

const cueMapSchema = z.object({
  orgId: idSchema,
  songId: idSchema,
  cueMapId: idSchema.optional(),
  name: labelSchema,
  frameRate: z.union([z.literal(24), z.literal(25), z.literal(29.97), z.literal(30)]),
  dropFrame: z.enum(["df", "ndf"]),
  cues: z.array(z.object({
    sectionId: idSchema,
    triggerTc: z.string().max(16),
    ppSlideIndex: z.number().int().min(0).nullable().optional(),
  })).max(500),
});

export const listSongs = createServerFn({ method: "GET" })
  .inputValidator((data: unknown) => parseOrThrow(z.object({ orgId: idSchema }), data))
  .handler(async ({ data }) => {
    await assertOrgPermission(data.orgId, "songs:access");
    return getPrisma().song.findMany({
      where: { orgId: data.orgId },
      orderBy: [{ title: "asc" }, { artist: "asc" }],
      include: { _count: { select: { sections: true, cueMaps: true } } },
    });
  });

export const getSong = createServerFn({ method: "GET" })
  .inputValidator((data: unknown) => parseOrThrow(songIdInput, data))
  .handler(async ({ data }) => {
    await assertOrgPermission(data.orgId, "songs:access");
    const song = await getPrisma().song.findFirst({
      where: { id: data.songId, orgId: data.orgId },
      include: {
        sections: { orderBy: { sortOrder: "asc" } },
        cueMaps: {
          orderBy: { createdAt: "asc" },
          include: { cues: { orderBy: { sortOrder: "asc" }, include: { section: true } } },
        },
      },
    });
    if (!song) throw new Error("Song not found");
    return song;
  });

export const saveSongMetadata = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => parseOrThrow(metadataSchema, data))
  .handler(async ({ data }) => {
    await assertOrgPermission(data.orgId, "songs:manage");
    const prisma = getPrisma();
    const details = {
      title: data.title.trim(), artist: data.artist, ccliNumber: data.ccliNumber,
      bpm: data.bpm, keySignature: data.keySignature,
    };
    if (!data.songId) return prisma.song.create({ data: { orgId: data.orgId, ...details } });
    const existing = await prisma.song.findFirst({ where: { id: data.songId, orgId: data.orgId }, select: { id: true } });
    if (!existing) throw new Error("Song not found");
    return prisma.song.update({ where: { id: existing.id }, data: details });
  });

export const createSong = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => parseOrThrow(createSongSchema, data))
  .handler(async ({ data }) => {
    await assertOrgPermission(data.orgId, "songs:manage");
    return getPrisma().song.create({
      data: {
        orgId: data.orgId,
        title: data.title.trim(),
        artist: data.artist,
        ccliNumber: data.ccliNumber,
        bpm: data.bpm,
        keySignature: data.keySignature,
        sections: {
          create: data.sections.map((section, sortOrder) => ({
            orgId: data.orgId,
            label: section.label,
            lyrics: section.lyrics,
            sortOrder,
          })),
        },
      },
      select: { id: true },
    });
  });

export const saveSongSection = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => parseOrThrow(sectionSchema, data))
  .handler(async ({ data }) => {
    await assertOrgPermission(data.orgId, "songs:manage");
    const prisma = getPrisma();
    const song = await prisma.song.findFirst({ where: { id: data.songId, orgId: data.orgId }, select: { id: true } });
    if (!song) throw new Error("Song not found");
    if (data.sectionId) {
      const section = await prisma.songSection.findFirst({ where: { id: data.sectionId, songId: song.id, orgId: data.orgId }, select: { id: true } });
      if (!section) throw new Error("Song section not found");
      return prisma.songSection.update({ where: { id: section.id }, data: { label: data.label.trim(), lyrics: data.lyrics, sourceSlideIndex: data.sourceSlideIndex } });
    }
    const last = await prisma.songSection.findFirst({ where: { songId: song.id, orgId: data.orgId }, orderBy: { sortOrder: "desc" }, select: { sortOrder: true } });
    return prisma.songSection.create({ data: { orgId: data.orgId, songId: song.id, label: data.label.trim(), lyrics: data.lyrics, sourceSlideIndex: data.sourceSlideIndex, sortOrder: (last?.sortOrder ?? -1) + 1 } });
  });

export const deleteSongSection = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => parseOrThrow(songIdInput.extend({ sectionId: idSchema, confirmMapped: z.boolean().default(false) }), data))
  .handler(async ({ data }) => {
    await assertOrgPermission(data.orgId, "songs:manage");
    const prisma = getPrisma();
    const section = await prisma.songSection.findFirst({ where: { id: data.sectionId, songId: data.songId, orgId: data.orgId }, include: { _count: { select: { cues: true } } } });
    if (!section) throw new Error("Song section not found");
    if (section._count.cues > 0 && !data.confirmMapped) throw new Error("This section is used in a cue map. Confirm deletion to remove those mapped cues too.");
    await prisma.songSection.delete({ where: { id: section.id } });
    return { ok: true };
  });

export const reorderSongSections = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => parseOrThrow(songIdInput.extend({ sectionIds: z.array(idSchema).max(100) }), data))
  .handler(async ({ data }) => {
    await assertOrgPermission(data.orgId, "songs:manage");
    const prisma = getPrisma();
    const existing = await prisma.songSection.findMany({ where: { songId: data.songId, orgId: data.orgId }, select: { id: true } });
    if (existing.length !== data.sectionIds.length || new Set(data.sectionIds).size !== existing.length || existing.some((row) => !data.sectionIds.includes(row.id))) throw new Error("Section order is incomplete.");
    await prisma.$transaction(data.sectionIds.map((id, sortOrder) => prisma.songSection.update({ where: { id }, data: { sortOrder } })));
    return { ok: true };
  });

export const saveSongCueMap = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => parseOrThrow(cueMapSchema, data))
  .handler(async ({ data }) => {
    await assertOrgPermission(data.orgId, "songs:manage");
    const format: TimecodeFormat = { frameRate: data.frameRate as FrameRate, dropFrame: data.dropFrame };
    if (format.dropFrame === "df" && format.frameRate !== 29.97) throw new Error("Drop-frame is only valid at 29.97 fps.");
    const parsed = data.cues.map((cue, sortOrder) => {
      const timecode = parseTimecodeString(cue.triggerTc);
      if (!timecode || !isValidTimecode(timecode, format)) throw new Error(`Invalid cue timecode: ${cue.triggerTc}`);
      return { ...cue, sortOrder, triggerFrame: timecodeToFrames(timecode, format) };
    });
    const prisma = getPrisma();
    const sections = await prisma.songSection.findMany({ where: { songId: data.songId, orgId: data.orgId }, select: { id: true } });
    const sectionIds = new Set(sections.map((section) => section.id));
    if (parsed.some((cue) => !sectionIds.has(cue.sectionId))) throw new Error("Cue map contains a section from another song.");
    const formatJson = JSON.stringify(format);
    let cueMapId = data.cueMapId;
    if (cueMapId) {
      const existing = await prisma.songCueMap.findFirst({ where: { id: cueMapId, songId: data.songId, orgId: data.orgId }, select: { id: true } });
      if (!existing) throw new Error("Cue map not found");
      await prisma.songCueMap.update({ where: { id: existing.id }, data: { name: data.name.trim(), format: formatJson } });
    } else {
      const created = await prisma.songCueMap.create({ data: { orgId: data.orgId, songId: data.songId, name: data.name.trim(), format: formatJson }, select: { id: true } });
      cueMapId = created.id;
    }
    await prisma.$transaction([
      prisma.songCue.deleteMany({ where: { cueMapId, orgId: data.orgId } }),
      ...parsed.map((cue) => prisma.songCue.create({ data: { orgId: data.orgId, cueMapId: cueMapId!, sectionId: cue.sectionId, triggerTc: cue.triggerTc, triggerFrame: cue.triggerFrame, sortOrder: cue.sortOrder, ppSlideIndex: cue.ppSlideIndex ?? null } })),
    ]);
    return { ok: true, cueMapId };
  });

export const deleteSong = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => parseOrThrow(songIdInput, data))
  .handler(async ({ data }) => {
    await assertOrgPermission(data.orgId, "songs:manage");
    const prisma = getPrisma();
    const song = await prisma.song.findFirst({ where: { id: data.songId, orgId: data.orgId }, select: { id: true } });
    if (!song) throw new Error("Song not found");
    await prisma.song.delete({ where: { id: song.id } });
    return { ok: true };
  });

export interface BridgePresentationSummary {
  uuid: string;
  name: string;
}

export interface BridgePresentation extends BridgePresentationSummary {
  slides: Array<{ index: number; text: string; label: string; notes: string }>;
}

type ProPresenterQueryResult =
  | { kind: "offline" }
  | { kind: "success"; response: string | undefined };

const PROPRESENTER_IMPORT_BRIDGE_VERSION = "0.1.11";

function parsePresentationSummaries(response: string | undefined): BridgePresentationSummary[] {
  if (!response) return [];
  const value: unknown = JSON.parse(response);
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate): BridgePresentationSummary[] => {
    if (!candidate || typeof candidate !== "object") return [];
    const item = candidate as Record<string, unknown>;
    if (typeof item.uuid !== "string" || typeof item.name !== "string") return [];
    return [{ uuid: item.uuid, name: item.name }];
  });
}

function parsePresentation(response: string | undefined): BridgePresentation {
  if (!response) throw new Error("ProPresenter returned an empty presentation.");
  const value: unknown = JSON.parse(response);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("ProPresenter returned an invalid presentation.");
  }
  const item = value as Record<string, unknown>;
  if (typeof item.uuid !== "string" || typeof item.name !== "string" || !Array.isArray(item.slides)) {
    throw new Error("ProPresenter returned an invalid presentation.");
  }
  const slides = item.slides.flatMap((slide, index) => {
      if (!slide || typeof slide !== "object") return [];
      const row = slide as Record<string, unknown>;
      return [{ index: typeof row.index === "number" ? row.index : index, text: String(row.text ?? ""), label: String(row.label ?? `Slide ${index + 1}`), notes: String(row.notes ?? "") }];
    });
  return { uuid: item.uuid, name: item.name, slides };
}

async function queryProPresenter(orgId: string, command: Record<string, string>): Promise<ProPresenterQueryResult> {
  const bridge = (env as Cloudflare.Env).BRIDGE_RELAY.get((env as Cloudflare.Env).BRIDGE_RELAY.idFromName(orgId));
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const status = await bridge.getBridgeStatus();
    const target = status.connectedTargets.find((candidate) => candidate.startsWith("propresenter:"));
    if (!target) return { kind: "offline" };
    if (!isBridgeVersionAtLeast(status.version, PROPRESENTER_IMPORT_BRIDGE_VERSION)) {
      throw new Error(
        `Song import requires Venue Bridge ${PROPRESENTER_IMPORT_BRIDGE_VERSION} or newer. Update the Bridge on the venue Mac, then reconnect.`,
      );
    }
    const result = await bridge.dispatchBridgeMessage({
      type: "command",
      id: crypto.randomUUID(),
      protocol: "propresenter",
      target,
      command: JSON.stringify(command),
    });
    if (result.success) return { kind: "success", response: result.response };
    const retryableHandoff = result.error === "Venue Bridge was replaced" || result.error === "Venue Bridge disconnected";
    if (!retryableHandoff || attempt === 1) {
      throw new Error(result.error ?? "ProPresenter did not answer.");
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error("ProPresenter did not answer.");
}

export const listProPresenterSongs = createServerFn({ method: "GET" })
  .inputValidator((data: unknown) => parseOrThrow(z.object({ orgId: idSchema }), data))
  .handler(async ({ data }) => {
    await assertOrgPermission(data.orgId, "songs:manage");
    const result = await queryProPresenter(data.orgId, { action: "query-presentations" });
    if (result.kind === "offline") return { connected: false, presentations: [] as BridgePresentationSummary[] };
    return { connected: true, presentations: parsePresentationSummaries(result.response) };
  });

export const getProPresenterSong = createServerFn({ method: "GET" })
  .inputValidator((data: unknown) => parseOrThrow(z.object({ orgId: idSchema, presentationUuid: idSchema }), data))
  .handler(async ({ data }) => {
    await assertOrgPermission(data.orgId, "songs:manage");
    const result = await queryProPresenter(data.orgId, {
      action: "query-presentation",
      presentationUuid: data.presentationUuid,
    });
    if (result.kind === "offline") throw new Error("Venue Bridge or ProPresenter is offline.");
    const presentation = parsePresentation(result.response);
    if (!presentation.slides.length) {
      throw new Error("This ProPresenter presentation has no readable text slides.");
    }
    return presentation;
  });

export const importProPresenterSong = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => parseOrThrow(z.object({
    orgId: idSchema,
    presentation: z.object({ uuid: idSchema, name: labelSchema, slides: z.array(z.object({ index: z.number().int().min(0), text: textSchema, label: z.string().max(120), notes: textSchema })).max(500) }),
    strategy: z.enum(["merge", "replace", "skip"]).default("merge"),
  }), data))
  .handler(async ({ data }) => {
    await assertOrgPermission(data.orgId, "songs:manage");
    const prisma = getPrisma();
    const existing = await prisma.song.findFirst({ where: { orgId: data.orgId, ppPresentationUuid: data.presentation.uuid }, include: { sections: true } });
    if (existing && data.strategy === "skip") return { songId: existing.id, changed: false };
    const song = existing
      ? await prisma.song.update({ where: { id: existing.id }, data: { title: data.presentation.name, importSource: "propresenter" } })
      : await prisma.song.create({ data: { orgId: data.orgId, title: data.presentation.name, ppPresentationUuid: data.presentation.uuid, importSource: "propresenter" } });
    if (existing && data.strategy === "replace") await prisma.songSection.deleteMany({ where: { songId: song.id, orgId: data.orgId } });
    const current = existing && data.strategy === "merge" ? new Map(existing.sections.map((section) => [section.sourceSlideIndex, section])) : new Map();
    for (const [sortOrder, slide] of data.presentation.slides.entries()) {
      const old = current.get(slide.index);
      if (old) await prisma.songSection.update({ where: { id: old.id }, data: { label: slide.label || `Slide ${slide.index + 1}`, lyrics: slide.text, sortOrder } });
      else await prisma.songSection.create({ data: { orgId: data.orgId, songId: song.id, label: slide.label || `Slide ${slide.index + 1}`, lyrics: slide.text, sortOrder, sourceSlideIndex: slide.index } });
    }
    return { songId: song.id, changed: true };
  });
