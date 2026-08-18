import { cn } from "@/lib/utils";

const TONE = {
  neutral: "text-board-text",
  success: "text-green-400",
  warning: "text-yellow-300",
  danger: "text-red-400",
} as const;

export function StatusMetric({
  label,
  value,
  tone = "neutral",
  compact = false,
}: {
  label: string;
  value: string | number;
  tone?: keyof typeof TONE;
  compact?: boolean;
}) {
  return (
    <div className={cn("flex min-w-0 flex-col justify-center rounded-lg border border-board-border/70 bg-board-bg/45 px-3 py-2", compact ? "min-h-12" : "min-h-[62px]")}>
      <strong className={cn("leading-none font-semibold tabular-nums", compact ? "text-base" : "text-lg", TONE[tone])}>{value}</strong>
      <span className="mt-1.5 truncate text-[10px] font-medium uppercase tracking-[0.12em] text-board-muted">{label}</span>
    </div>
  );
}
