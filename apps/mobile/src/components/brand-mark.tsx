import { useId } from "react";
import Svg, { Defs, LinearGradient, Path, Stop } from "react-native-svg";

export function BrandMark({ size = 44 }: { size?: number }) {
  // SVG definition IDs share the document namespace on web. A stable unique
  // suffix keeps marks rendered during navigation transitions from stealing
  // each other's gradients.
  const id = useId().replaceAll(":", "");
  const ringId = `showpilot-ring-${id}`;
  const northId = `showpilot-north-${id}`;
  const southId = `showpilot-south-${id}`;

  return (
    <Svg width={size} height={size} viewBox="0 0 48 48" fill="none">
      <Path
        d="M24 4A20 20 0 1 1 4 24"
        stroke={`url(#${ringId})`}
        strokeWidth={2.5}
        strokeLinecap="round"
      />
      <Path d="M24 8L30 26H18L24 8Z" fill={`url(#${northId})`} />
      <Path d="M24 40L18 26H30L24 40Z" fill={`url(#${southId})`} />
      <Defs>
        <LinearGradient id={ringId} x1="4" y1="24" x2="44" y2="24">
          <Stop stopColor="#FFC107" />
          <Stop offset="1" stopColor="#E65100" />
        </LinearGradient>
        <LinearGradient id={northId} x1="24" y1="8" x2="24" y2="26">
          <Stop stopColor="#FFC107" />
          <Stop offset="1" stopColor="#FF8F00" />
        </LinearGradient>
        <LinearGradient id={southId} x1="24" y1="26" x2="24" y2="40">
          <Stop stopColor="#E65100" />
          <Stop offset="1" stopColor="#BF360C" />
        </LinearGradient>
      </Defs>
    </Svg>
  );
}
