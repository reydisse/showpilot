export interface SquareAvatarGeometry {
  sourceX: number;
  sourceY: number;
  sourceSize: number;
  outputSize: number;
}

const MANAGED_AVATAR_PATH = /^\/api\/user\/avatar\/[^/?#]+\.jpg$/;

/**
 * Keep ShowPilot-owned avatars portable across web, Desktop, LAN, and native
 * clients. Older records may contain the origin of the machine that uploaded
 * them, so reduce those URLs to the same-origin asset path at the UI boundary.
 */
export function getPortableAvatarUrl(value: string | null | undefined): string | null {
  const candidate = value?.trim();
  if (!candidate) return null;

  if (candidate.startsWith("/")) {
    const parsed = new URL(candidate, "https://showpilot.invalid");
    return MANAGED_AVATAR_PATH.test(parsed.pathname)
      ? `${parsed.pathname}${parsed.search}`
      : null;
  }

  try {
    const parsed = new URL(candidate);
    if (MANAGED_AVATAR_PATH.test(parsed.pathname)) return `${parsed.pathname}${parsed.search}`;
    if (parsed.protocol !== "https:") return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

export function getSquareAvatarGeometry(width: number, height: number, maxPixels: number): SquareAvatarGeometry {
  if (![width, height, maxPixels].every((value) => Number.isFinite(value) && value > 0)) {
    throw new Error("Avatar dimensions must be positive numbers");
  }
  const sourceSize = Math.min(width, height);
  return {
    sourceX: (width - sourceSize) / 2,
    sourceY: (height - sourceSize) / 2,
    sourceSize,
    outputSize: Math.min(sourceSize, maxPixels),
  };
}
