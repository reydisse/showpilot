import { useEffect } from "react";
import { useRouter } from "@tanstack/react-router";
import { getEffectiveAccessSnapshot } from "@/lib/access-grants";

const ACCESS_REFRESH_MS = 10_000;

export function AccessGrantSyncController({
  orgId,
  revision,
}: {
  orgId: string;
  revision: string;
}) {
  const router = useRouter();

  useEffect(() => {
    let stopped = false;
    let checking = false;

    const check = async () => {
      if (checking || stopped) return;
      checking = true;
      try {
        const snapshot = await getEffectiveAccessSnapshot({ data: { orgId } });
        if (!stopped && snapshot.revision !== revision) {
          await router.invalidate();
        }
      } catch {
        // A temporary network failure must not sign the operator out or erase
        // the last server-authorized navigation state.
      } finally {
        checking = false;
      }
    };

    const interval = window.setInterval(check, ACCESS_REFRESH_MS);
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") void check();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      stopped = true;
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [orgId, revision, router]);

  return null;
}
