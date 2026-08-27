import { normalizeChecklistLabel } from "@/lib/smart-checklist-rules";
import type { DepartmentKey } from "@/lib/departments";

export interface ChecklistEntryIdentity {
  id: string;
  orgId: string;
}

export interface ChecklistEntryDeleteStore {
  deleteMany: (where: ChecklistEntryIdentity) => Promise<{ count: number }>;
}

export interface ChecklistTemplateIdentity {
  id: string;
  label: string;
}

export type ChecklistTemplateWrite =
  | { kind: "existing"; id: string }
  | { kind: "new"; id: string; label: string; category: DepartmentKey };

/**
 * Reuse the first matching template. Labels are the template identity users
 * understand, so punctuation and casing must not create near-duplicates.
 */
export function findChecklistTemplateId(
  templates: readonly ChecklistTemplateIdentity[],
  label: string,
): string | null {
  const normalizedLabel = normalizeChecklistLabel(label);
  if (!normalizedLabel) throw new Error("Checklist items must include letters or numbers");
  return templates.find((template) => normalizeChecklistLabel(template.label) === normalizedLabel)?.id ?? null;
}

/**
 * Concurrent creators of the same org template must choose the same id. The
 * label is immutable in the product, so this remains stable for its lifetime.
 */
export async function createChecklistTemplateId(orgId: string, label: string): Promise<string> {
  const normalizedLabel = normalizeChecklistLabel(label);
  if (!normalizedLabel) throw new Error("Checklist items must include letters or numbers");
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${orgId}\u0000${normalizedLabel}`),
  );
  const fingerprint = Array.from(new Uint8Array(digest).slice(0, 20), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return `checklist-${fingerprint}`;
}

/** Delete one visible service entry without touching its reusable template. */
export async function deleteChecklistEntryCore({
  store,
  entry,
}: {
  store: ChecklistEntryDeleteStore;
  entry: ChecklistEntryIdentity;
}) {
  const result = await store.deleteMany(entry);
  if (result.count === 0) throw new Error("Checklist entry not found");
  return { ok: true as const };
}
