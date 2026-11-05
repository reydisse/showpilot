import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { useTimecode, type UseTimecodeReturn } from "@/hooks/useTimecode";
import { getTimecodeShows } from "@/lib/timecode-shows";
import type { TimecodeShow } from "@/types/timecode";
import { ShowSwitcherMenu } from "@/components/show-switcher-menu";

interface ShowTimecode extends UseTimecodeReturn {
  shows: TimecodeShow[];
  showId: string | null;
  showLoading: boolean;
  showError: string | null;
  selectShow: (showId: string) => void;
  refreshShows: () => void;
}
const TimecodeContext = createContext<ShowTimecode | null>(null);
interface ProviderProps { children: ReactNode; enabled: boolean; orgId: string }
type ShowList = { status: "loading" } | { status: "ready"; shows: TimecodeShow[] } | { status: "error" };

export function TimecodeProvider(props: ProviderProps) {
  return <TimecodeSession key={props.orgId} {...props} />;
}

function TimecodeSession({ children, enabled, orgId }: ProviderProps) {
  const [showList, setShowList] = useState<ShowList>({ status: "loading" });
  const [refresh, setRefresh] = useState(0);
  const [showId, setShowId] = useState<string | null>(null);
  // Select the initial live show once. Another operator's active-show change
  // must not silently retarget this tab's clock and automation.
  useEffect(() => {
    if (!enabled) return;
    let current = true;
    setShowList({ status: "loading" });
    const timeout = setTimeout(() => {
      current = false;
      setShowList({ status: "error" });
    }, 10_000);
    void getTimecodeShows({ data: { orgId } }).then(result => {
      if (!current) return;
      setShowList({ status: "ready", shows: result.shows });
      setShowId(selected => selected ?? result.activeShowId);
    }).catch(() => {
      if (current) setShowList({ status: "error" });
    }).finally(() => clearTimeout(timeout));
    return () => { current = false; clearTimeout(timeout); };
  }, [enabled, orgId, refresh]);
  const timecode = useTimecode({ orgId, showId, enabled: enabled && showId !== null });
  const shows = showList.status === "ready" ? showList.shows : [];
  const selectShow = (id: string) => {
    if (timecode.isMaster || timecode.generatorPending || !shows.some(show => show.id === id)) return;
    setShowId(id);
  };
  return <TimecodeContext.Provider value={{ ...timecode, showId, shows, selectShow,
    showLoading: enabled && showList.status === "loading",
    showError: showList.status === "error" ? "Could not load shows. Retry to select a timecode show." : null,
    refreshShows: () => setRefresh(value => value + 1),
  }}>{children}</TimecodeContext.Provider>;
}

export function useShowTimecode() {
  const timecode = useContext(TimecodeContext);
  if (!timecode) throw new Error("useShowTimecode must be used inside TimecodeProvider");
  return timecode;
}

export function TimecodeShowPicker() {
  const timecode = useShowTimecode();
  if (timecode.showLoading) return <p role="status" className="text-sm text-board-muted">Loading shows…</p>;
  if (timecode.showError) return <p role="alert" className="text-sm text-red-400">{timecode.showError} <button onClick={timecode.refreshShows}>Retry</button></p>;
  if (!timecode.shows.length) return <p className="text-sm text-board-muted">Create a show in Rundown to use timecode. <button onClick={timecode.refreshShows}>Refresh shows</button></p>;
  return <div className="flex flex-wrap items-center gap-2">
    <span className="text-xs text-board-muted">Timecode for</span>
    <ShowSwitcherMenu shows={timecode.shows} selectedId={timecode.showId} onSelect={show => timecode.selectShow(show.id)} disabled={timecode.isMaster || timecode.generatorPending !== null} />
    <button className="text-xs text-board-muted" onClick={timecode.refreshShows}>Refresh shows</button>
    {timecode.isMaster && <span className="text-xs text-board-muted">Stop this generator before switching shows.</span>}
  </div>;
}
