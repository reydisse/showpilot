import { useFocusEffect } from "expo-router";
import { useCallback, useState } from "react";

/**
 * Expo Router keeps previous screens mounted in the navigation stack. Query
 * intervals therefore need route focus in addition to application focus, or
 * every screen visited in a session continues polling in the background.
 */
export function useScreenFocus(): boolean {
  const [isFocused, setIsFocused] = useState(false);

  useFocusEffect(useCallback(() => {
    setIsFocused(true);
    return () => setIsFocused(false);
  }, []));

  return isFocused;
}

export function useScreenPollingInterval(intervalMs: number): number | false {
  return useScreenFocus() ? intervalMs : false;
}
