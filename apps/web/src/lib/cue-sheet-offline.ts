import { cueSheetOperationSchema, type CueSheetWrite } from "./cue-sheet-writes";

export interface CueDraft {
  showId: string; serviceDate: string; itemId: string; columnId: string;
  text: string; expectedText: string; pending: boolean; version: number;
  request?: CueSheetWrite;
}
export const cueDraftKey = (orgId: string, userId: string) => `showpilot:cue-drafts:v1:${orgId}:${userId}`;
export const cueCellKey = (showId: string, itemId: string, columnId: string) => JSON.stringify([showId, itemId, columnId]);

/** Validate storage without rewriting a captured packet or its receipt id. */
export function restoreCueDrafts(raw: string | null, orgId: string): Map<string, CueDraft> {
  if (!raw) return new Map();
  const saved: unknown = JSON.parse(raw);
  if (!Array.isArray(saved)) throw new Error("Invalid cue draft journal");
  const drafts = new Map<string, CueDraft>();
  for (const entry of saved) {
    if (!entry || typeof entry !== "object") throw new Error("Invalid cue draft");
    const draft = entry as CueDraft;
    const check = cueSheetOperationSchema.safeParse({ kind: "note", showId: draft.showId, serviceDate: draft.serviceDate, itemId: draft.itemId, columnId: draft.columnId, text: draft.text, expectedText: draft.expectedText });
    if (!check.success || draft.pending !== true || !Number.isSafeInteger(draft.version) || draft.version < 0) throw new Error("Invalid cue draft");
    if (draft.request !== undefined) {
      const request = draft.request;
      if (!request || typeof request !== "object") throw new Error("Invalid cue receipt");
      if (request.orgId !== orgId || typeof request.requestId !== "string" || !/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(request.requestId)) throw new Error("Invalid cue receipt scope");
      if (!cueSheetOperationSchema.safeParse(request.operation).success || request.operation.kind !== "note" || request.operation.showId !== draft.showId || request.operation.serviceDate !== draft.serviceDate || request.operation.itemId !== draft.itemId || request.operation.columnId !== draft.columnId) throw new Error("Invalid cue receipt body");
    }
    const key = cueCellKey(draft.showId, draft.itemId, draft.columnId);
    if (drafts.has(key)) throw new Error("Duplicate cue draft");
    drafts.set(key, draft);
  }
  return drafts;
}
export function serializeCueDrafts(drafts: Map<string, CueDraft>): string {
  return JSON.stringify([...drafts.values()].filter(draft => draft.pending));
}
