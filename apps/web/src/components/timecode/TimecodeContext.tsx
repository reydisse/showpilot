import { createContext, useContext, type ReactNode } from "react";
import { useTimecode, type UseTimecodeReturn } from "@/hooks/useTimecode";

const TimecodeContext = createContext<UseTimecodeReturn | null>(null);

export function TimecodeProvider({
  children,
  enabled,
  orgId,
}: {
  children: ReactNode;
  enabled: boolean;
  orgId: string;
}) {
  const timecode = useTimecode({ orgId, enabled });
  return <TimecodeContext.Provider value={timecode}>{children}</TimecodeContext.Provider>;
}

export function useOrgTimecode() {
  const timecode = useContext(TimecodeContext);
  if (!timecode) throw new Error("useOrgTimecode must be used inside TimecodeProvider");
  return timecode;
}
