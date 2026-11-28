import type React from "react";
import { Loader2 } from "lucide-react";

/**
 * Tech Manager — A (Doop canvas aneicgaHqk, "Tech Manager" page): panels,
 * section labels, callouts and the control tile. Colours come from `.schedule-a`.
 */

export const tmEyebrow = "text-xs font-medium uppercase tracking-[0.08em] text-[var(--sa-ink-3)]";
export const tmSecondary =
  "inline-flex h-8 items-center justify-center gap-1.5 whitespace-nowrap rounded-lg border border-[var(--sa-border-strong)] bg-[var(--sa-surface-2)] px-3 text-[13px] font-medium text-board-text hover:bg-[var(--sa-surface-3)] disabled:opacity-40 max-lg:h-11";
export const tmDanger =
  "inline-flex h-8 items-center justify-center gap-1.5 whitespace-nowrap rounded-lg border border-[var(--sa-danger)]/30 bg-[var(--sa-danger)]/10 px-3 text-[13px] font-medium text-[var(--sa-danger)] hover:bg-[var(--sa-danger)]/15 disabled:opacity-40 max-lg:h-11";
export const tmPrimary =
  "inline-flex h-8 items-center justify-center gap-1.5 whitespace-nowrap rounded-lg bg-fire-500 px-3 text-[13px] font-semibold text-[#1a1300] hover:bg-fire-400 disabled:opacity-40 max-lg:h-11";
export const tmLink =
  "inline-flex min-h-8 items-center gap-1 text-[13px] font-medium text-board-text underline decoration-[var(--sa-border-strong)] underline-offset-[3px] hover:decoration-board-text max-lg:min-h-11";
export const tmIconButton =
  "inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-[var(--sa-ink-3)] hover:bg-[var(--sa-surface-2)] hover:text-board-text disabled:opacity-30 max-lg:h-11 max-lg:w-11";

export type Tone = "ok" | "warn" | "danger" | "muted";
export const toneText: Record<Tone, string> = {
  ok: "text-[var(--sa-ok)]",
  warn: "text-[var(--sa-warn)]",
  danger: "text-[var(--sa-danger)]",
  muted: "text-[var(--sa-ink-2)]",
};

/** A card with an icon, a title, an optional quiet subtitle and a trailing action. */
export function TmPanel({ icon: Icon, title, subtitle, action, children, footer, className = "", label }: {
  icon: React.ElementType;
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  action?: React.ReactNode;
  children?: React.ReactNode;
  footer?: React.ReactNode;
  className?: string;
  label?: string;
}) {
  return (
    <section aria-label={label} className={`min-w-0 overflow-hidden rounded-xl border border-[var(--sa-border)] bg-[var(--sa-surface)] ${className}`}>
      <header className="flex min-h-[52px] flex-wrap items-center gap-x-2.5 gap-y-1 px-4 pt-3.5">
        <Icon aria-hidden="true" className="h-4 w-4 shrink-0 text-[var(--sa-ink-3)]" strokeWidth={1.75} />
        <h2 className="text-[15px] font-semibold text-board-text">{title}</h2>
        {subtitle ? <span className="min-w-0 text-xs text-[var(--sa-ink-3)]">{subtitle}</span> : null}
        {action ? <span className="ml-auto flex items-center gap-2">{action}</span> : null}
      </header>
      {children ? <div className="px-4 pb-4 pt-2.5">{children}</div> : <div className="h-3" />}
      {footer ? <div className="flex flex-wrap items-center gap-2 border-t border-[var(--sa-border)] px-4 py-3">{footer}</div> : null}
    </section>
  );
}

/** An icon-and-words status, never colour alone. */
export function StatusWord({ tone, icon: Icon, children, className = "" }: { tone: Tone; icon: React.ElementType; children: React.ReactNode; className?: string }) {
  return (
    <span className={`inline-flex items-center gap-1.5 whitespace-nowrap text-xs font-medium ${toneText[tone]} ${className}`}>
      <Icon aria-hidden="true" className="h-3.5 w-3.5 shrink-0" strokeWidth={1.75} />
      {children}
    </span>
  );
}

/** A boxed notice: amber for "look at this", red for "this failed". */
export function Callout({ tone = "warn", icon: Icon, title, children, action, role }: {
  tone?: "warn" | "danger" | "muted";
  icon: React.ElementType;
  title: React.ReactNode;
  children?: React.ReactNode;
  action?: React.ReactNode;
  role?: "alert" | "status";
}) {
  const box = tone === "danger" ? "border-[var(--sa-danger)]/35 bg-[var(--sa-danger)]/[0.06]" : tone === "warn" ? "border-[var(--sa-warn)]/30 bg-[var(--sa-warn)]/[0.06]" : "border-[var(--sa-border)] bg-[var(--sa-surface-2)]";
  return (
    <div role={role} className={`flex flex-wrap items-start gap-3 rounded-lg border px-3.5 py-3 ${box}`}>
      <Icon aria-hidden="true" className={`mt-0.5 h-4 w-4 shrink-0 ${tone === "muted" ? "text-[var(--sa-ink-3)]" : toneText[tone]}`} strokeWidth={1.75} />
      <div className="min-w-0 flex-1 basis-[13rem]">
        <p className={`text-[13px] font-semibold ${tone === "danger" ? "text-[var(--sa-danger)]" : "text-board-text"}`}>{title}</p>
        {children ? <div className="mt-0.5 text-xs leading-[1.5] text-[var(--sa-ink-2)]">{children}</div> : null}
      </div>
      {action ? <div className="flex shrink-0 flex-wrap items-center gap-2 self-center">{action}</div> : null}
    </div>
  );
}

/** A big square action: icon, label and a one-line reason under it. */
export function ControlTile({ icon: Icon, label, detail, disabled, danger, onClick }: {
  icon: React.ElementType;
  label: string;
  detail: string;
  disabled?: boolean;
  danger?: boolean;
  onClick(): void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={`group flex min-h-[86px] min-w-0 flex-col items-start gap-1 rounded-lg border px-3.5 py-3 text-left transition-colors disabled:cursor-not-allowed ${danger && !disabled ? "border-[var(--sa-danger)]/40 bg-[var(--sa-danger)]/[0.05] hover:bg-[var(--sa-danger)]/10" : "border-[var(--sa-border)] bg-[var(--sa-surface-2)]/60 hover:border-[var(--sa-border-strong)] hover:bg-[var(--sa-surface-2)] disabled:border-[var(--sa-border)]/70 disabled:bg-transparent"}`}
    >
      <Icon aria-hidden="true" className={`mb-1 h-3.5 w-3.5 ${danger && !disabled ? "text-[var(--sa-danger)]" : "text-[var(--sa-ink-3)]"}`} strokeWidth={1.75} />
      <span className={`text-[13px] font-semibold ${disabled ? "text-[var(--sa-ink-3)]" : danger ? "text-[var(--sa-danger)]" : "text-board-text"}`}>{label}</span>{" "}
      <span className={`text-xs leading-[1.4] ${disabled ? "text-[var(--sa-ink-3)]" : "text-[var(--sa-ink-2)]"}`}>{detail}</span>
    </button>
  );
}

export function Spinner({ className = "h-3.5 w-3.5" }: { className?: string }) {
  return <Loader2 aria-hidden="true" className={`${className} shrink-0 animate-spin motion-reduce:animate-none`} />;
}

export function initials(name: string | null | undefined): string {
  if (!name) return "—";
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase() ?? "").join("");
}
