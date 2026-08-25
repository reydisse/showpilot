type ProcessProbe = (pid: number, signal: 0) => void;

export function parseParentProcessId(raw: string | undefined): number | null {
  if (!raw || !/^\d+$/.test(raw)) return null;
  const pid = Number(raw);
  return Number.isSafeInteger(pid) && pid > 1 ? pid : null;
}

export function isParentProcessAlive(
  pid: number,
  probe: ProcessProbe = process.kill,
): boolean {
  try {
    probe(pid, 0);
    return true;
  } catch (cause) {
    return cause instanceof Error && "code" in cause && cause.code === "EPERM";
  }
}

export function startParentProcessMonitor(
  rawPid: string | undefined,
  onOrphaned: () => void,
  intervalMs = 5_000,
): NodeJS.Timeout | null {
  const pid = parseParentProcessId(rawPid);
  if (!pid) return null;

  const timer = setInterval(() => {
    if (!isParentProcessAlive(pid)) {
      clearInterval(timer);
      onOrphaned();
    }
  }, intervalMs);
  timer.unref();
  return timer;
}
