export interface ChecklistEntryIdentity {
  id: string;
  orgId: string;
}

export interface ChecklistEntryDeleteStore {
  deleteMany: (where: ChecklistEntryIdentity) => Promise<{ count: number }>;
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
