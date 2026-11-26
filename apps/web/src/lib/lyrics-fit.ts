/** Largest size (to 0.25px) for which `fits` holds, searching between `min` and `max`. */
export function largestFittingSize(fits: (size: number) => boolean, max: number, min = 1): number {
  let low = min;
  let high = max;
  while (high - low > 0.25) {
    const size = (low + high) / 2;
    if (fits(size)) low = size;
    else high = size;
  }
  return low;
}

/**
 * Singers read a slide phrase by phrase, so a wrapped line ("…held in / Your hands")
 * is harder to follow than slightly smaller text. Keep authored lines intact unless
 * that would shrink the slide below this share of the wrapped size.
 */
export const KEEP_LINES_MIN_RATIO = 0.6;

export function chooseLyricFit(unwrappedSize: number, wrappedSize: number): { wrap: boolean; size: number } {
  return unwrappedSize >= wrappedSize * KEEP_LINES_MIN_RATIO
    ? { wrap: false, size: unwrappedSize }
    : { wrap: true, size: wrappedSize };
}

/**
 * The Confidence "text size" setting. Above 100% it raises the size cap so text may
 * grow where there is room; below 100% it shrinks the fitted size, so the operator
 * always sees the change even when the slide is already limited by space.
 */
export function applyLyricSizeSetting(fit: (cap: number) => number, cap: number, setting: number): number {
  return fit(cap * Math.max(setting, 1)) * Math.min(setting, 1);
}
