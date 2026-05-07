import { useEffect, useRef } from "react";
import { getTodayDateString } from "@/lib/utils";

type UseServiceDateRolloverOptions = {
  serviceDate: string;
  onTodayChanged: (nextToday: string) => void | Promise<void>;
  intervalMs?: number;
};

export function useServiceDateRollover({
  serviceDate,
  onTodayChanged,
  intervalMs = 30000,
}: UseServiceDateRolloverOptions) {
  const serviceDateRef = useRef(serviceDate);
  const onTodayChangedRef = useRef(onTodayChanged);
  const lastTodayRef = useRef(getTodayDateString());

  useEffect(() => {
    serviceDateRef.current = serviceDate;
  }, [serviceDate]);

  useEffect(() => {
    onTodayChangedRef.current = onTodayChanged;
  }, [onTodayChanged]);

  useEffect(() => {
    const interval = setInterval(() => {
      const nextToday = getTodayDateString();
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
  }, [intervalMs]);
}
