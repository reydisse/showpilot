import { Link } from "@tanstack/react-router";
import { useDesktopLocalShow } from "@/hooks/useDesktopLocalShow";

export function DesktopLocalShowNotice({
  orgId,
  slug,
}: {
  orgId?: string;
  slug?: string;
}) {
  const { status, error } = useDesktopLocalShow();
  if (error || status?.mode !== "finished") return null;
  if (!orgId || status.orgId !== orgId || !slug)
    return (
      <span role="status" className="text-sm text-amber-200">
        Local progress is saved. Open its workspace to review.
      </span>
    );
  return (
    <Link
      to="/$slug/rundown"
      params={{ slug }}
      search={{ show: status.showId, date: status.serviceDate }}
      className="inline-flex min-h-11 items-center rounded-md px-2 text-sm text-amber-200 underline focus-visible:outline-2 focus-visible:outline-offset-2"
    >
      Review saved local progress
    </Link>
  );
}
