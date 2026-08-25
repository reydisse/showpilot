import { useSyncExternalStore } from "react";
import { Platform, useColorScheme } from "react-native";

export interface AppColors {
  stage: string;
  stageRaised: string;
  panel: string;
  panelStrong: string;
  border: string;
  borderSoft: string;
  text: string;
  textMuted: string;
  textFaint: string;
  amber: string;
  amberPressed: string;
  amberText: string;
  amberSoft: string;
  amberBorder: string;
  amberStrongBorder: string;
  green: string;
  greenSoft: string;
  greenBorder: string;
  red: string;
  redSoft: string;
  redBorder: string;
  redStrongBorder: string;
  blue: string;
  black: string;
  white: string;
  overlay: string;
}

const darkColors: AppColors = {
  stage: "#0A0B0D",
  stageRaised: "#101216",
  panel: "#15171C",
  panelStrong: "#1B1E24",
  border: "#2A2E36",
  borderSoft: "#20232A",
  text: "#F2F3F5",
  textMuted: "#9CA1AB",
  textFaint: "#6D737E",
  amber: "#FFC107",
  amberPressed: "#E6A900",
  amberText: "#FFC107",
  amberSoft: "rgba(255, 193, 7, 0.12)",
  amberBorder: "rgba(255, 193, 7, 0.30)",
  amberStrongBorder: "rgba(255, 193, 7, 0.55)",
  green: "#3DD68C",
  greenSoft: "rgba(61, 214, 140, 0.10)",
  greenBorder: "rgba(61, 214, 140, 0.38)",
  red: "#FF6369",
  redSoft: "rgba(255, 99, 105, 0.09)",
  redBorder: "rgba(255, 99, 105, 0.35)",
  redStrongBorder: "rgba(255, 99, 105, 0.52)",
  blue: "#5B9CFF",
  black: "#090909",
  white: "#FFFFFF",
  overlay: "rgba(0, 0, 0, 0.68)",
};

const lightColors: AppColors = {
  stage: "#F3EFE7",
  stageRaised: "#FAF7F0",
  panel: "#EEE7DC",
  panelStrong: "#E5DCCD",
  border: "#C9BDAE",
  borderSoft: "#DED4C7",
  text: "#29241E",
  textMuted: "#625A50",
  textFaint: "#7D7266",
  amber: "#FFB300",
  amberPressed: "#D99500",
  amberText: "#945100",
  amberSoft: "rgba(184, 106, 0, 0.10)",
  amberBorder: "rgba(166, 91, 0, 0.28)",
  amberStrongBorder: "rgba(166, 91, 0, 0.48)",
  green: "#137A47",
  greenSoft: "rgba(19, 122, 71, 0.10)",
  greenBorder: "rgba(19, 122, 71, 0.32)",
  red: "#B8323A",
  redSoft: "rgba(184, 50, 58, 0.08)",
  redBorder: "rgba(184, 50, 58, 0.30)",
  redStrongBorder: "rgba(184, 50, 58, 0.45)",
  blue: "#285CC4",
  black: "#17130D",
  white: "#FFFFFF",
  overlay: "rgba(41, 36, 30, 0.54)",
};

export interface AppTheme {
  colorScheme: "light" | "dark";
  colors: AppColors;
  statusBarStyle: "light" | "dark";
}

const darkTheme: AppTheme = { colorScheme: "dark", colors: darkColors, statusBarStyle: "light" };
const lightTheme: AppTheme = { colorScheme: "light", colors: lightColors, statusBarStyle: "dark" };

const lightSchemeQuery = "(prefers-color-scheme: light)";

function subscribeToWebColorScheme(onChange: () => void) {
  if (Platform.OS !== "web" || typeof window === "undefined") return () => undefined;
  const media = window.matchMedia(lightSchemeQuery);
  media.addEventListener("change", onChange);
  return () => media.removeEventListener("change", onChange);
}

function getWebColorScheme() {
  if (Platform.OS !== "web" || typeof window === "undefined") return "dark" as const;
  return window.matchMedia(lightSchemeQuery).matches ? "light" as const : "dark" as const;
}

function getServerColorScheme() {
  return "dark" as const;
}

export function useAppTheme(): AppTheme {
  const nativeColorScheme = useColorScheme();
  const webColorScheme = useSyncExternalStore(subscribeToWebColorScheme, getWebColorScheme, getServerColorScheme);
  const colorScheme = Platform.OS === "web" ? webColorScheme : nativeColorScheme;
  return colorScheme === "light" ? lightTheme : darkTheme;
}

export function createThemedStyles<T>(factory: (colors: AppColors) => T) {
  const lightStyles = factory(lightColors);
  const darkStyles = factory(darkColors);

  return function useThemedStyles(): T {
    return useAppTheme().colorScheme === "light" ? lightStyles : darkStyles;
  };
}

export const radii = {
  small: 10,
  medium: 14,
  large: 20,
  pill: 999,
} as const;

export const spacing = {
  xsmall: 6,
  small: 10,
  medium: 16,
  large: 24,
  xlarge: 32,
} as const;

export const fontFamily = Platform.select({
  ios: "System",
  android: "sans-serif",
  default: "System",
});
