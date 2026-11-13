/** Measured binary search usable by DOM and asynchronous native text layout. */
export type TextFit = { low: number; high: number; size: number; done: boolean };
const precision = 0.25;
function step(low: number, high: number): TextFit {
  const done = high - low <= precision;
  return { low, high, size: done ? low : (low + high) / 2, done };
}
export function startTextFit(maximum: number, minimum = 1): TextFit {
  return step(minimum, Math.max(minimum, maximum));
}
export function advanceTextFit(current: TextFit, fits: boolean): TextFit {
  if (current.done) return current;
  return fits ? step(current.size, current.high) : step(current.low, current.size);
}
