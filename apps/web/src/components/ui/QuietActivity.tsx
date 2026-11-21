/** Quiet progress treatment shared by controls, static with reduced motion. */
export function QuietActivity({ label = "Loading" }: { label?: string }) {
  return <span role="progressbar" aria-label={label} className="inline-block h-1 w-8 rounded-full bg-current opacity-40 motion-safe:animate-pulse" />;
}
