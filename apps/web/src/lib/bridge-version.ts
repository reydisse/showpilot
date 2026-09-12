const VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/;

function parseVersion(value: string): readonly [number, number, number] | null {
  const match = VERSION_PATTERN.exec(value.trim());
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** Compare the Bridge protocol version without accepting partial versions. */
export function isBridgeVersionAtLeast(current: string | undefined, minimum: string): boolean {
  if (!current) return false;
  const currentParts = parseVersion(current);
  const minimumParts = parseVersion(minimum);
  if (!currentParts || !minimumParts) return false;

  for (let index = 0; index < currentParts.length; index += 1) {
    if (currentParts[index] > minimumParts[index]) return true;
    if (currentParts[index] < minimumParts[index]) return false;
  }
  return true;
}
