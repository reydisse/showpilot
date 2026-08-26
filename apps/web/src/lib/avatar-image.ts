export interface SquareAvatarGeometry {
  sourceX: number;
  sourceY: number;
  sourceSize: number;
  outputSize: number;
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
