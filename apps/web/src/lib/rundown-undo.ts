/** Restore one row without overwriting edits that arrived after its deletion. */
export function restoreRundownItem<T extends { id: string }>(items: readonly T[], removed: { item: T; index: number; nextId: string | null }): T[] {
  if (items.some((item) => item.id === removed.item.id)) return [...items];
  const nextIndex = removed.nextId ? items.findIndex((item) => item.id === removed.nextId) : -1;
  const index = nextIndex >= 0 ? nextIndex : Math.min(removed.index, items.length);
  return [...items.slice(0, index), removed.item, ...items.slice(index)];
}
