/** Human-facing hierarchy: section 2 owns playable rows 2.1, 2.2, etc. */
export function rundownItemNumbers<T extends { id: string; type: string }>(items: readonly T[]): Map<string, string> {
  const numbers = new Map<string, string>();
  if (!items.some((item) => item.type === "header")) {
    items.forEach((item, index) => numbers.set(item.id, String(index + 1)));
    return numbers;
  }

  let section = 0;
  let child = 0;
  let unsectioned = 0;
  for (const item of items) {
    if (item.type === "header") {
      section = Math.max(section + 1, unsectioned + 1);
      child = 0;
      numbers.set(item.id, String(section));
    } else if (section === 0) {
      unsectioned += 1;
      numbers.set(item.id, String(unsectioned));
    } else {
      child += 1;
      numbers.set(item.id, `${section}.${child}`);
    }
  }
  return numbers;
}
