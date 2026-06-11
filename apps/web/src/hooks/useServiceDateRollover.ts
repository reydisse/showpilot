import { useEffect, useRef } from "react";
import { getTodayDateString } from "@/lib/utils";

type UseServiceDateRolloverOptions = {
  serviceDate: string;
  onTodayChanged: (nextToday: string) => void | Promise<void>;
  intervalMs?: number;
  timeZone?: string;
};

export function useServiceDateRollover({
  serviceDate,
  onTodayChanged,
  intervalMs = 30000,
  timeZone,
}: UseServiceDateRolloverOptions) {
  const serviceDateRef = useRef(serviceDate);
  const onTodayChangedRef = useRef(onTodayChanged);
  const lastTodayRef = useRef(getTodayDateString(timeZone));

  useEffect(() => {
    serviceDateRef.current = serviceDate;
  }, [serviceDate]);

  useEffect(() => {
    onTodayChangedRef.current = onTodayChanged;
  }, [onTodayChanged]);

  useEffect(() => {
    lastTodayRef.current = getTodayDateString(timeZone);
  }, [timeZone]);

  useEffect(() => {
    const interval = setInterval(() => {
      const nextToday = getTodayDateString(timeZone);
      const lastToday = lastTodayRef.current;

      if (nextToday === lastToday) {
        return;
      }

      lastTodayRef.current = nextToday;
      if (serviceDateRef.current !== lastToday) {
        return;
      }

      serviceDateRef.current = nextToday;
      void onTodayChangedRef.current(nextToday);
    }, intervalMs);

    return () => clearInterval(interval);
  }, [intervalMs, timeZone]);
}
