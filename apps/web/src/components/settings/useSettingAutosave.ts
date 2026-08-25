import { useCallback, useEffect, useRef, useState } from "react";

export type SettingSaveState =
  | { kind: "saved" }
  | { kind: "saving" }
  | { kind: "error"; message: string };

interface SettingAutosaveOptions {
  initialSettings: Record<string, string>;
  persist: (key: string, value: string) => Promise<unknown>;
}

/**
 * Keeps settings optimistic while serializing writes for each key.
 *
 * Two fast changes to one control must reach the server in the same order the
 * operator made them. Different controls can still save in parallel.
 */
export function useSettingAutosave({
  initialSettings,
  persist,
}: SettingAutosaveOptions) {
  const [settings, setSettings] = useState<Record<string, string>>(
    initialSettings,
  );
  const [saveState, setSaveState] = useState<SettingSaveState>({
    kind: "saved",
  });
  const localSettings = useRef(initialSettings);
  const committedSettings = useRef(initialSettings);
  const saveRequestIds = useRef<Record<string, number>>({});
  const saveQueues = useRef<Record<string, Promise<void> | undefined>>({});
  const pendingSaveCount = useRef(0);
  const persistRef = useRef(persist);

  useEffect(() => {
    persistRef.current = persist;
  }, [persist]);

  const saveSetting = useCallback(
    (key: string, value: string): Promise<void> => {
      if (localSettings.current[key] === value) {
        return Promise.resolve();
      }

      const requestId = (saveRequestIds.current[key] ?? 0) + 1;
      saveRequestIds.current[key] = requestId;
      pendingSaveCount.current += 1;
      localSettings.current = { ...localSettings.current, [key]: value };
      setSettings(localSettings.current);
      setSaveState({ kind: "saving" });

      const persistForRequest = persistRef.current;
      const previousSave = saveQueues.current[key] ?? Promise.resolve();
      const currentSave = previousSave.then(async () => {
        try {
          await persistForRequest(key, value);
          committedSettings.current = {
            ...committedSettings.current,
            [key]: value,
          };
        } catch (error) {
          if (requestId === saveRequestIds.current[key]) {
            localSettings.current = {
              ...localSettings.current,
              [key]: committedSettings.current[key] ?? "",
            };
            setSettings(localSettings.current);
            setSaveState({
              kind: "error",
              message:
                error instanceof Error
                  ? error.message
                  : "That setting could not be saved",
            });
          }
        } finally {
          pendingSaveCount.current = Math.max(
            0,
            pendingSaveCount.current - 1,
          );
          if (pendingSaveCount.current === 0) {
            setSaveState((current) =>
              current.kind === "error" ? current : { kind: "saved" },
            );
          }
        }
      });

      saveQueues.current[key] = currentSave;
      void currentSave.finally(() => {
        if (saveQueues.current[key] === currentSave) {
          delete saveQueues.current[key];
        }
      });
      return currentSave;
    },
    [],
  );

  const getSetting = useCallback(
    (key: string, fallback = "") => settings[key] ?? fallback,
    [settings],
  );

  return { getSetting, saveSetting, saveState, settings };
}
