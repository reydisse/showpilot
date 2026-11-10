import { useEffect, useState } from "react";

type Choices<T> = { status: "loading" } | { status: "error"; message: string } | { status: "ready"; value: T };

/** Each selector owns a bounded request; old responses cannot replace a new selection. */
export function useCueChoices<T>(load: () => Promise<T>) {
  const [attempt, setAttempt] = useState(0);
  const [view, setView] = useState<{ load: typeof load; attempt: number; choices: Choices<T> }>({ load, attempt, choices: { status: "loading" } });
  useEffect(() => {
    let current = true;
    const setChoices = (choices: Choices<T>) => setView({ load, attempt, choices });
    setChoices({ status: "loading" });
    const timeout = setTimeout(() => { current = false; setChoices({ status: "error", message: "Loading choices timed out. Try again." }); }, 10000);
    void Promise.resolve().then(load).then(value => { if (current) setChoices({ status: "ready", value }); })
      .catch(error => { if (current) setChoices({ status: "error", message: error instanceof Error ? error.message : "Could not load choices." }); })
      .finally(() => clearTimeout(timeout));
    return () => { current = false; clearTimeout(timeout); };
  }, [load, attempt]);
  const choices: Choices<T> = view.load === load && view.attempt === attempt ? view.choices : { status: "loading" };
  return { choices, retry: () => setAttempt(value => value + 1) };
}
