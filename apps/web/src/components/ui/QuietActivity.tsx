/** Progress is visible without narrating background work. */
export function QuietActivity({ label = "Loading" }: { label?: string }) {
  return <span className="inline-flex size-4 shrink-0 items-center justify-center align-middle">
    <span role="progressbar" aria-label={label} className="size-3.5 animate-spin rounded-full border-2 border-current border-r-transparent motion-reduce:animate-none" />
    <span className="sr-only">{label}</span>
  </span>;
}
