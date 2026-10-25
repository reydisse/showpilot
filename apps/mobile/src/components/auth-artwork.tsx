import { useId } from "react";
import type { SignInDesign } from "@showpilot/shared";
import Svg, {
  Circle,
  Defs,
  Ellipse,
  G,
  Line,
  LinearGradient,
  Path,
  RadialGradient,
  Rect,
  Stop,
  Text as SvgText,
} from "react-native-svg";

/** Native vectors for the same three seasonal studies used on web. */
export function AuthArtwork({ design }: { design: SignInDesign }) {
  const id = useId().replaceAll(":", "");
  const gold = `auth-gold-${id}`;
  const fade = `auth-fade-${id}`;
  const glow = `auth-glow-${id}`;
  const background =
    design === "in-sync"
      ? "#15191a"
      : design === "afterglow"
        ? "#151614"
        : "#191917";

  return (
    <Svg
      width="100%"
      height="100%"
      viewBox="0 0 500 400"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      <Defs>
        <LinearGradient id={gold} x1="0%" y1="0%" x2="100%" y2="100%">
          <Stop offset="0" stopColor="#a48a49" />
          <Stop offset="0.65" stopColor="#4c4532" />
          <Stop offset="1" stopColor="#292a25" />
        </LinearGradient>
        <LinearGradient id={fade} x1="0%" y1="0%" x2="0%" y2="100%">
          <Stop offset="0.45" stopColor={background} stopOpacity="0" />
          <Stop offset="1" stopColor={background} />
        </LinearGradient>
        <RadialGradient id={glow}>
          <Stop offset="0" stopColor="#bc8b23" stopOpacity="0.25" />
          <Stop offset="1" stopColor={background} stopOpacity="0" />
        </RadialGradient>
      </Defs>
      {design === "rhythm" ? (
        <>
          <G rotation={-9} origin="250,200" opacity={0.8}>
            {Array.from({ length: 20 }, (_, index) => (
              <G
                key={index}
                transform={`translate(${40 + (index % 5) * 84}, ${30 + Math.floor(index / 5) * 84})`}
              >
                <Rect
                  width={77}
                  height={77}
                  rx={3}
                  fill="#ffffff02"
                  stroke="#b6a16715"
                />
                <Path
                  d="M 7 39 A 32 32 0 0 1 71 39 L 71 71 L 39 71 A 32 32 0 0 1 7 39 Z"
                  fill={`url(#${gold})`}
                  rotation={index * 90}
                  origin="39,39"
                  opacity={index % 4 === 3 ? 0.35 : 1}
                />
              </G>
            ))}
          </G>
          <Rect width={500} height={400} fill={`url(#${fade})`} />
        </>
      ) : design === "afterglow" ? (
        <>
          <Ellipse cx={250} cy={175} rx={240} ry={175} fill={`url(#${glow})`} />
          <Ellipse cx={250} cy={310} rx={118} ry={14} fill="#00000022" />
          <G rotation={-24} origin="250,190">
            {[0, 1, 2, 3, 4].map((ring) => (
              <G key={ring}>
                <Ellipse
                  cx={250}
                  cy={210 - ring * 12}
                  rx={150 - ring * 29}
                  ry={82 - ring * 15}
                  stroke="#00000033"
                  strokeWidth={18 - ring * 2}
                  fill="none"
                />
                <Ellipse
                  cx={250}
                  cy={200 - ring * 12}
                  rx={150 - ring * 29}
                  ry={82 - ring * 15}
                  stroke={`url(#${gold})`}
                  strokeWidth={14 - ring * 2}
                  fill="none"
                />
              </G>
            ))}
            <Circle cx={250} cy={144} r={6} fill="#e0be69" />
          </G>
          <SvgText
            x={250}
            y={355}
            textAnchor="middle"
            fill="#8d8b7c"
            fontSize={8}
            letterSpacing={2}
          >
            35° / READY WHEN YOU ARE
          </SvgText>
        </>
      ) : (
        <>
          <G rotation={-9} origin="250,200" opacity={0.65}>
            {["PRE-SHOW", "WELCOME", "THE MOMENT", "WHAT'S NEXT"].map(
              (label, index) => (
                <G key={label} transform={`translate(35, ${55 + index * 56})`}>
                  <Line x1={0} y1={0} x2={430} y2={0} stroke="#ffffff18" />
                  <SvgText x={0} y={30} fontSize={9} fill="#89928d">
                    0{index + 1}
                  </SvgText>
                  <Rect
                    x={38}
                    y={24}
                    width={index === 1 ? 190 : 135}
                    height={5}
                    rx={2}
                    fill="#76817a44"
                  />
                  <SvgText
                    x={430}
                    y={30}
                    textAnchor="end"
                    fontSize={7}
                    fill="#89928d"
                  >
                    {label}
                  </SvgText>
                </G>
              ),
            )}
          </G>
          <G rotation={4} origin="270,210">
            <Rect
              x={91}
              y={101}
              width={354}
              height={232}
              rx={12}
              fill="#00000033"
            />
            <Rect
              x={85}
              y={88}
              width={354}
              height={232}
              rx={12}
              fill="#242b26"
              stroke="#a8b3a333"
            />
            <Circle cx={112} cy={118} r={3} fill="#c2b576" />
            <SvgText
              x={123}
              y={121}
              fill="#a9b5a8"
              fontSize={8}
              letterSpacing={1.3}
            >
              ALL TOGETHER
            </SvgText>
            <SvgText x={113} y={178} fill="#d8dece" fontSize={32}>
              One team.
            </SvgText>
            <SvgText x={113} y={218} fill="#d8dece" fontSize={32}>
              In perfect time.
            </SvgText>
            <Rect x={113} y={253} width={298} height={2} fill="#ffffff16" />
            <Rect x={113} y={253} width={164} height={2} fill="#b3a365" />
            <Rect x={240} y={250} width={2} height={8} fill="#ead590" />
            <SvgText
              x={113}
              y={282}
              fill="#a0ad9f"
              fontSize={7}
              letterSpacing={0.8}
            >
              STAGE · SOUND · VISION
            </SvgText>
            <SvgText
              x={411}
              y={282}
              textAnchor="end"
              fill="#a0ad9f"
              fontSize={7}
            >
              SHOWPILOT
            </SvgText>
          </G>
        </>
      )}
    </Svg>
  );
}
