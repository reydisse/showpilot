import { createServerFn } from "@tanstack/react-start";
import { env } from "cloudflare:workers";
import { z } from "zod";
import { assertOrgPermission } from "@/lib/org-access";
import { getPrisma } from "@/lib/db";
import { idSchema, labelSchema, parseOrThrow, textSchema } from "@/lib/validation";
import { parseTimecodeString, timecodeToFrames } from "@/lib/timecode";
import type { FrameRate, TimecodeFormat } from "@/types/timecode";
import { isBridgeVersionAtLeast } from "@/lib/bridge-version";
import { planProPresenterMerge } from "@/lib/song-import";
import { getD1 } from "@/lib/d1";
import { runSongWrite } from "@/lib/song-write.server";

const writeRequest = { requestId: z.string().min(16).max(128).regex(/^[A-Za-z0-9_-]+$/).optional() };
const songResult = z.object({ id: idSchema });
const savedResult = z.object({ ok: z.literal(true) });
const mapResult = savedResult.extend({ cueMapId: idSchema });
const importResult = z.object({ songId: idSchema, changed: z.boolean(), preservedMappedSections: z.array(z.object({ sectionId: idSchema, label: z.string(), reason: z.string() })).optional() });

const songIdInput = z.object({ orgId: idSchema, songId: idSchema });
const metadataSchema = z.object({
  ...writeRequest,
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
  ...writeRequest,
  orgId: idSchema,
  songId: idSchema,
  sectionId: idSchema.optional(),
  label: labelSchema,
  lyrics: textSchema,
  sourceSlideIndex: z.number().int().min(0).nullable().optional(),
});

const cueMapSchema = z.object({
  ...writeRequest,
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

const songDraftSchema = metadataSchema.extend({
  songId: idSchema,
  sections: z.array(z.object({
    id: idSchema,
    label: labelSchema,
    lyrics: textSchema,
    sourceSlideIndex: z.number().int().min(0).nullable(),
  })).max(100),
  cueMap: cueMapSchema.omit({ orgId: true, songId: true, requestId: true }),
});

function parseCueDrafts(data: z.infer<typeof cueMapSchema>) {
  const format: TimecodeFormat = {
    frameRate: data.frameRate as FrameRate,
    dropFrame: data.dropFrame,
  };
  if (format.dropFrame === "df" && format.frameRate !== 29.97) {
    throw new Error("Drop-frame is only valid at 29.97 fps.");
  }
  const cues = data.cues.map((cue, sortOrder) => {
    const timecode = parseTimecodeString(cue.triggerTc, format);
    if (!timecode) {
      throw new Error(`Invalid cue timecode: ${cue.triggerTc}`);
    }
    return {
      ...cue,
      sortOrder,
      triggerFrame: timecodeToFrames(timecode, format),
    };
  });
  return { cues, format };
}

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
  .inputValidator((data: unknown) => parseOrThrow(metadataSchema.extend({ songId: idSchema }), data))
  .handler(async ({ data }) => {
    const { user } = await assertOrgPermission(data.orgId, "songs:manage");
    const saved = await runSongWrite({ orgId: data.orgId, actorId: user.id, requestId: data.requestId, kind: "metadata", payload: data, targetSongId: data.songId }, songResult, async () => ({
      songId: data.songId, result: { id: data.songId }, statements: [getD1().prepare(`UPDATE song SET title=?,artist=?,ccliNumber=?,bpm=?,keySignature=?,updatedAt=? WHERE id=? AND orgId=?`)
        .bind(data.title, data.artist, data.ccliNumber, data.bpm, data.keySignature, new Date().toISOString(), data.songId, data.orgId)],
    }));
    const song = await getPrisma().song.findFirst({ where: { id: saved.id, orgId: data.orgId } });
    if (!song) throw new Error("The saved song has been removed.");
    return song;
  });

export const createSong = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => parseOrThrow(createSongSchema, data))
  .handler(async ({ data }) => {
    const { user } = await assertOrgPermission(data.orgId, "songs:manage");
    return runSongWrite({ orgId: data.orgId, actorId: user.id, requestId: data.requestId, kind: "create", payload: data }, songResult, async () => {
      const db = getD1(); const id = crypto.randomUUID(); const now = new Date().toISOString();
      const statements = [
        db.prepare(`INSERT INTO song(id,orgId,title,artist,ccliNumber,bpm,keySignature,createdAt,updatedAt)
          VALUES(?,?,?,?,?,?,?,?,?)`).bind(id, data.orgId, data.title, data.artist, data.ccliNumber, data.bpm, data.keySignature, now, now),
        ...data.sections.map((section, sortOrder) => db.prepare(`INSERT INTO song_section(id,orgId,songId,label,lyrics,sortOrder)
          VALUES(?,?,?,?,?,?)`).bind(crypto.randomUUID(), data.orgId, id, section.label, section.lyrics, sortOrder)),
      ];
      return { songId: id, result: { id }, statements };
    });
  });

export const saveSongSection = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => parseOrThrow(sectionSchema, data))
  .handler(async ({ data }) => {
    const { user } = await assertOrgPermission(data.orgId, "songs:manage");
    const saved = await runSongWrite({ orgId: data.orgId, actorId: user.id, requestId: data.requestId, kind: "section", payload: data, targetSongId: data.songId }, songResult, async () => {
      const db = getD1(); const id = data.sectionId ?? crypto.randomUUID();
      if (data.sectionId) {
        const section = await getPrisma().songSection.findFirst({ where: { id, songId: data.songId, orgId: data.orgId } });
        if (!section) throw new Error("Song section not found");
        return { songId: data.songId, result: { id }, statements: [db.prepare("UPDATE song_section SET label=?,lyrics=?,sourceSlideIndex=? WHERE id=? AND songId=? AND orgId=?")
          .bind(data.label, data.lyrics, data.sourceSlideIndex === undefined ? section.sourceSlideIndex : data.sourceSlideIndex, id, data.songId, data.orgId)] };
      }
      return { songId: data.songId, result: { id }, statements: [db.prepare(`INSERT INTO song_section(id,orgId,songId,label,lyrics,sourceSlideIndex,sortOrder)
        SELECT ?,?,?,?,?,?,COALESCE(MAX(sortOrder),-1)+1 FROM song_section WHERE orgId=? AND songId=?`)
        .bind(id, data.orgId, data.songId, data.label, data.lyrics, data.sourceSlideIndex ?? null, data.orgId, data.songId)] };
    });
    const section = await getPrisma().songSection.findFirst({ where: { id: saved.id, songId: data.songId, orgId: data.orgId } });
    if (!section) throw new Error("The saved section has been removed. Retrying will not recreate it.");
    return section;
  });

export const deleteSongSection = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => parseOrThrow(songIdInput.extend({ ...writeRequest, sectionId: idSchema, confirmMapped: z.boolean().default(false) }), data))
  .handler(async ({ data }) => {
    const { user } = await assertOrgPermission(data.orgId, "songs:manage");
    return runSongWrite({ orgId: data.orgId, actorId: user.id, requestId: data.requestId, kind: "delete-section", payload: data, targetSongId: data.songId }, savedResult, async () => {
      const section = await getPrisma().songSection.findFirst({ where: { id: data.sectionId, songId: data.songId, orgId: data.orgId }, include: { _count: { select: { cues: true } } } });
      if (!section) throw new Error("Song section not found");
      if (section._count.cues > 0 && !data.confirmMapped) throw new Error("This section is used in a cue map. Confirm deletion to remove those mapped cues too.");
      return { songId: data.songId, result: { ok: true as const }, statements: [getD1().prepare("DELETE FROM song_section WHERE id=? AND songId=? AND orgId=?")
        .bind(data.sectionId, data.songId, data.orgId)] };
    });
  });

export const reorderSongSections = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => parseOrThrow(songIdInput.extend({ ...writeRequest, sectionIds: z.array(idSchema).max(100) }), data))
  .handler(async ({ data }) => {
    const { user } = await assertOrgPermission(data.orgId, "songs:manage");
    return runSongWrite({ orgId: data.orgId, actorId: user.id, requestId: data.requestId, kind: "reorder", payload: data, targetSongId: data.songId }, savedResult, async () => {
      const prisma = getPrisma();
      const existing = await prisma.songSection.findMany({ where: { songId: data.songId, orgId: data.orgId }, select: { id: true } });
      if (existing.length !== data.sectionIds.length || new Set(data.sectionIds).size !== existing.length || existing.some((row) => !data.sectionIds.includes(row.id))) throw new Error("Section order is incomplete.");
      // A single update also verifies the complete set at write time, so a
      // concurrent section deletion cannot leave a partially applied order.
      const order = JSON.stringify(data.sectionIds);
      const db = getD1();
      const statements = [db.prepare(`UPDATE song_section SET sortOrder = (SELECT key FROM json_each(?) WHERE value=song_section.id)
        WHERE orgId=? AND songId=? AND (SELECT COUNT(*) FROM song_section WHERE orgId=? AND songId=?)=?
        AND NOT EXISTS(SELECT 1 FROM song_section s WHERE s.orgId=? AND s.songId=? AND s.id NOT IN (SELECT value FROM json_each(?)))`)
        .bind(order, data.orgId, data.songId, data.orgId, data.songId, data.sectionIds.length, data.orgId, data.songId, order)];
      return { songId: data.songId, result: { ok: true as const }, statements };
    });
  });

function cueMapWrites(data: z.infer<typeof cueMapSchema>, cueMapId: string, parsed: ReturnType<typeof parseCueDrafts>): D1PreparedStatement[] {
  const db = getD1(); const now = new Date().toISOString();
  return [
    data.cueMapId
      ? db.prepare("UPDATE song_cue_map SET name=?,format=?,updatedAt=? WHERE id=? AND orgId=? AND songId=?")
        .bind(data.name, JSON.stringify(parsed.format), now, cueMapId, data.orgId, data.songId)
      : db.prepare("INSERT INTO song_cue_map(id,orgId,songId,name,format,createdAt,updatedAt) VALUES(?,?,?,?,?,?,?)")
        .bind(cueMapId, data.orgId, data.songId, data.name, JSON.stringify(parsed.format), now, now),
    db.prepare("DELETE FROM song_cue WHERE cueMapId=? AND orgId=?").bind(cueMapId, data.orgId),
    ...parsed.cues.map(cue => db.prepare(`INSERT INTO song_cue(id,orgId,cueMapId,sectionId,triggerTc,triggerFrame,sortOrder,ppSlideIndex)
      VALUES(?,?,?,?,?,?,?,?)`).bind(crypto.randomUUID(), data.orgId, cueMapId, cue.sectionId, cue.triggerTc, cue.triggerFrame, cue.sortOrder, cue.ppSlideIndex ?? null)),
  ];
}

export const saveSongCueMap = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => parseOrThrow(cueMapSchema, data))
  .handler(async ({ data }) => {
    const { user } = await assertOrgPermission(data.orgId, "songs:manage");
    return runSongWrite({ orgId: data.orgId, actorId: user.id, requestId: data.requestId, kind: "cue-map", payload: data, targetSongId: data.songId }, mapResult, async () => {
      const parsed = parseCueDrafts(data);
      const prisma = getPrisma();
      const song = await prisma.song.findFirst({ where: { id: data.songId, orgId: data.orgId }, select: { id: true } });
      if (!song) throw new Error("Song not found");
      const sections = await prisma.songSection.findMany({ where: { songId: data.songId, orgId: data.orgId }, select: { id: true } });
      const sectionIds = new Set(sections.map(section => section.id));
      if (parsed.cues.some(cue => !sectionIds.has(cue.sectionId))) throw new Error("Cue map contains a section from another song.");
      const cueMapId = data.cueMapId ?? crypto.randomUUID();
      if (data.cueMapId) {
        const map = await prisma.songCueMap.findFirst({ where: { id: cueMapId, songId: data.songId, orgId: data.orgId }, select: { id: true } });
        if (!map) throw new Error("Cue map not found");
      }
      return { songId: data.songId, result: { ok: true as const, cueMapId }, statements: cueMapWrites(data, cueMapId, parsed) };
    });
  });

export const saveSongDraft = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => parseOrThrow(songDraftSchema, data))
  .handler(async ({ data }) => {
    const { user } = await assertOrgPermission(data.orgId, "songs:manage");
    return runSongWrite({ orgId: data.orgId, actorId: user.id, requestId: data.requestId, kind: "draft", payload: data, targetSongId: data.songId }, mapResult, async () => {
      const prisma = getPrisma();
      const [song, storedSections] = await Promise.all([
        prisma.song.findFirst({
          where: { id: data.songId, orgId: data.orgId },
          select: { id: true },
        }),
        prisma.songSection.findMany({
          where: { songId: data.songId, orgId: data.orgId },
          select: { id: true },
        }),
      ]);
      if (!song) throw new Error("Song not found");
      const sectionIds = new Set(data.sections.map((section) => section.id));
      if (
        sectionIds.size !== data.sections.length ||
        storedSections.length !== data.sections.length ||
        storedSections.some((section) => !sectionIds.has(section.id))
      ) {
        throw new Error(
          "The song arrangement changed elsewhere. Reload before saving your draft.",
        );
      }

      const cueInput = {
        orgId: data.orgId,
        songId: data.songId,
        ...data.cueMap,
      };
      const { cues: parsedCues, format } = parseCueDrafts(cueInput);
      if (parsedCues.some((cue) => !sectionIds.has(cue.sectionId))) {
        throw new Error("Cue map contains a section from another song.");
      }

      const cueMapId = data.cueMap.cueMapId ?? crypto.randomUUID();
      if (data.cueMap.cueMapId) {
        const existingMap = await prisma.songCueMap.findFirst({
          where: {
            id: data.cueMap.cueMapId,
            songId: data.songId,
            orgId: data.orgId,
          },
          select: { id: true },
        });
        if (!existingMap) throw new Error("Cue map not found");
      }

      const db = getD1();
      const statements = [
        db.prepare("UPDATE song SET title=?,artist=?,ccliNumber=?,bpm=?,keySignature=?,updatedAt=? WHERE id=? AND orgId=?")
          .bind(data.title, data.artist, data.ccliNumber, data.bpm, data.keySignature, new Date().toISOString(), song.id, data.orgId),
        ...data.sections.map((section, sortOrder) => db.prepare(`UPDATE song_section SET label=?,lyrics=?,sourceSlideIndex=?,sortOrder=?
          WHERE id=? AND songId=? AND orgId=?`).bind(section.label, section.lyrics, section.sourceSlideIndex, sortOrder, section.id, song.id, data.orgId)),
        ...cueMapWrites(cueInput, cueMapId, { cues: parsedCues, format }),
      ];
      return { songId: data.songId, result: { ok: true as const, cueMapId }, statements };
    });
  });

export const deleteSong = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => parseOrThrow(songIdInput.extend(writeRequest), data))
  .handler(async ({ data }) => {
    const { user } = await assertOrgPermission(data.orgId, "songs:manage");
    return runSongWrite({ orgId: data.orgId, actorId: user.id, requestId: data.requestId, kind: "delete", payload: data, targetSongId: data.songId }, savedResult, async () => ({
      songId: data.songId, result: { ok: true as const }, statements: [getD1().prepare("DELETE FROM song WHERE id=? AND orgId=?").bind(data.songId, data.orgId)],
    }));
  });

export interface BridgePresentationSummary {
  uuid: string;
  name: string;
}

export interface BridgePresentation extends BridgePresentationSummary {
  slides: Array<{ index: number; sourceId?: string; text: string; label: string; notes: string }>;
}

export interface ProPresenterLibraryFailure {
  id: string;
  name: string;
  error: string;
}

type ProPresenterQueryResult =
  | { kind: "offline" }
  | { kind: "success"; response: string | undefined };

const PROPRESENTER_IMPORT_BRIDGE_VERSION = "0.1.11";

function parsePresentationSummaries(response: string | undefined): {
  presentations: BridgePresentationSummary[];
  totalLibraries: number | null;
  readLibraries: number | null;
  failedLibraries: ProPresenterLibraryFailure[];
} {
  if (!response) return { presentations: [], totalLibraries: null, readLibraries: null, failedLibraries: [] };
  const value: unknown = JSON.parse(response);
  const record = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  const candidates = Array.isArray(value) ? value : Array.isArray(record?.presentations) ? record.presentations : [];
  const presentations = candidates.flatMap((candidate): BridgePresentationSummary[] => {
    if (!candidate || typeof candidate !== "object") return [];
    const item = candidate as Record<string, unknown>;
    if (typeof item.uuid !== "string" || typeof item.name !== "string") return [];
    return [{ uuid: item.uuid, name: item.name }];
  });
  const libraries = record?.libraries && typeof record.libraries === "object" && !Array.isArray(record.libraries)
    ? record.libraries as Record<string, unknown>
    : null;
  const failedLibraries = Array.isArray(libraries?.failed)
    ? libraries.failed.flatMap((candidate): ProPresenterLibraryFailure[] => {
        if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return [];
        const item = candidate as Record<string, unknown>;
        if (typeof item.id !== "string" || typeof item.name !== "string") return [];
        return [{ id: item.id, name: item.name, error: typeof item.error === "string" ? item.error : "Library could not be read." }];
      })
    : [];
  return {
    presentations,
    totalLibraries: typeof libraries?.total === "number" ? libraries.total : null,
    readLibraries: typeof libraries?.read === "number" ? libraries.read : null,
    failedLibraries,
  };
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
      return [{ index: typeof row.index === "number" ? row.index : index, sourceId: typeof row.sourceId === "string" ? row.sourceId : "", text: String(row.text ?? ""), label: String(row.label ?? `Slide ${index + 1}`), notes: String(row.notes ?? "") }];
    });
  return { uuid: item.uuid, name: item.name, slides };
}

async function queryProPresenter(orgId: string, command: Record<string, unknown>, actorUserId: string): Promise<ProPresenterQueryResult> {
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
    }, { source: "operator", actorUserId });
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
  .inputValidator((data: unknown) => parseOrThrow(z.object({
    orgId: idSchema,
    libraryIds: z.array(idSchema).max(100).optional(),
  }), data))
  .handler(async ({ data }) => {
    const { user } = await assertOrgPermission(data.orgId, "songs:manage");
    const result = await queryProPresenter(data.orgId, {
      action: "query-presentations",
      ...(data.libraryIds?.length ? { libraryIds: data.libraryIds } : {}),
    }, user.id);
    if (result.kind === "offline") return {
      connected: false,
      presentations: [] as BridgePresentationSummary[],
      totalLibraries: null,
      readLibraries: null,
      failedLibraries: [] as ProPresenterLibraryFailure[],
    };
    return { connected: true, ...parsePresentationSummaries(result.response) };
  });

export const getProPresenterSong = createServerFn({ method: "GET" })
  .inputValidator((data: unknown) => parseOrThrow(z.object({ orgId: idSchema, presentationUuid: idSchema }), data))
  .handler(async ({ data }) => {
    const { user } = await assertOrgPermission(data.orgId, "songs:manage");
    const result = await queryProPresenter(data.orgId, {
      action: "query-presentation",
      presentationUuid: data.presentationUuid,
    }, user.id);
    if (result.kind === "offline") throw new Error("Venue Bridge or ProPresenter is offline.");
    const presentation = parsePresentation(result.response);
    if (!presentation.slides.length) {
      throw new Error("This ProPresenter presentation has no readable text slides.");
    }
    return presentation;
  });

export const importProPresenterSong = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => parseOrThrow(z.object({
    ...writeRequest,
    orgId: idSchema,
    presentation: z.object({ uuid: idSchema, name: labelSchema, slides: z.array(z.object({ index: z.number().int().min(0), sourceId: z.string().max(300).optional(), text: textSchema, label: z.string().max(120), notes: textSchema })).max(500) }),
    strategy: z.enum(["merge", "replace", "skip"]).default("merge"),
  }), data))
  .handler(async ({ data }) => {
    const { user } = await assertOrgPermission(data.orgId, "songs:manage");
    const target = await getPrisma().song.findFirst({ where: { orgId: data.orgId, ppPresentationUuid: data.presentation.uuid }, select: { id: true } });
    return runSongWrite({ orgId: data.orgId, actorId: user.id, requestId: data.requestId, kind: "import", payload: data, targetSongId: target?.id }, importResult, async () => {
      const prisma = getPrisma();
      const existing = await prisma.song.findFirst({
        where: { orgId: data.orgId, ppPresentationUuid: data.presentation.uuid },
        include: { sections: { include: { _count: { select: { cues: true } } } } },
      });
      if (existing?.id !== target?.id) throw new Error("The imported song changed while preparing this request. Retry to review its current arrangement.");
      if (existing && data.strategy === "skip") return { songId: existing.id, result: { songId: existing.id, changed: false }, statements: [] };
      const songId = existing?.id ?? crypto.randomUUID();
      const db = getD1(); const now = new Date().toISOString();
      const operations: D1PreparedStatement[] = [existing
        ? db.prepare("UPDATE song SET title=?,importSource='propresenter',updatedAt=? WHERE id=? AND orgId=?")
          .bind(data.presentation.name, now, existing.id, data.orgId)
        : db.prepare("INSERT INTO song(id,orgId,title,ppPresentationUuid,importSource,createdAt,updatedAt) VALUES(?,?,?,?,'propresenter',?,?)")
          .bind(songId, data.orgId, data.presentation.name, data.presentation.uuid, now, now)];
      const insertSlide = (slide: (typeof data.presentation.slides)[number], sortOrder: number) => db.prepare(`INSERT INTO song_section(id,orgId,songId,label,lyrics,sortOrder,sourceSlideIndex,sourceSlideId)
        VALUES(?,?,?,?,?,?,?,?)`).bind(crypto.randomUUID(), data.orgId, songId, slide.label || `Slide ${slide.index + 1}`, slide.text, sortOrder, slide.index, slide.sourceId ?? "");
      let preservedMappedSections: Array<{ sectionId: string; label: string; reason: string }> = [];

      if (existing && data.strategy === "replace") {
        operations.push(db.prepare("DELETE FROM song_section WHERE songId=? AND orgId=?").bind(songId, data.orgId));
        for (const [sortOrder, slide] of data.presentation.slides.entries()) operations.push(insertSlide(slide, sortOrder));
      } else {
        const plan = planProPresenterMerge(
          (existing?.sections ?? []).map((section) => ({
            id: section.id,
            label: section.label,
            lyrics: section.lyrics,
            sortOrder: section.sortOrder,
            sourceSlideIndex: section.sourceSlideIndex,
            sourceSlideId: section.sourceSlideId,
            cueCount: section._count.cues,
          })),
          data.presentation.slides,
        );
        preservedMappedSections = plan.preservedMappedSections;
        for (const write of plan.writes) {
          if (write.kind === "delete") {
            operations.push(db.prepare("DELETE FROM song_section WHERE id=? AND songId=? AND orgId=?").bind(write.sectionId, songId, data.orgId));
            continue;
          }
          operations.push(write.kind === "update"
            ? db.prepare("UPDATE song_section SET label=?,lyrics=?,sortOrder=?,sourceSlideIndex=?,sourceSlideId=? WHERE id=? AND songId=? AND orgId=?")
              .bind(write.slide.label || `Slide ${write.slide.index + 1}`, write.slide.text, write.sortOrder, write.slide.index, write.slide.sourceId ?? "", write.sectionId, songId, data.orgId)
            : insertSlide(write.slide, write.sortOrder));
        }
      }

      return { songId, result: { songId, changed: true, preservedMappedSections }, statements: operations };
    });
  });
