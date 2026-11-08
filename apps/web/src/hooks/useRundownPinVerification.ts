import { useEffect, useRef, useState } from "react";
import { withOperationTimeout } from "@/lib/operation-timeout";
import { getRundownPinCookieName } from "@/lib/rundown-pin";
import { validateRundownPin } from "@/lib/rbac";

type VerificationState =
  | { status: "idle" }
  | { status: "verifying" }
  | { status: "error"; message: string; occurredAt: number };

/** A dismissed or superseded PIN attempt can never grant local write access. */
export function useRundownPinVerification(
  orgId: string,
  onUnlocked: () => Promise<void>,
) {
  const [pin, setPin] = useState("");
  const [state, setState] = useState<VerificationState>({ status: "idle" });
  const request = useRef<AbortController | null>(null);
  useEffect(() => {
    setPin("");
    setState({ status: "idle" });
    return () => {
      request.current?.abort();
      request.current = null;
    };
  }, [orgId]);
  const submitting = state.status === "verifying";

  const verify = async () => {
    if (!pin.trim() || request.current) return;
    const controller = new AbortController();
    request.current = controller;
    setState({ status: "verifying" });
    try {
      const result = await withOperationTimeout(
        validateRundownPin({ data: { orgId, pin }, signal: controller.signal }),
        8_000,
        "PIN verification timed out. Your changes remain locked. Try again.",
      );
      if (request.current !== controller) return;
      if (!result.ok) {
        setState({
          status: "error",
          message: "Incorrect PIN. Please try again.",
          occurredAt: Date.now(),
        });
        return;
      }
      const secure = window.location.protocol === "https:" ? "; Secure" : "";
      document.cookie = `${getRundownPinCookieName(orgId)}=${encodeURIComponent(pin.trim())}; Path=/; Max-Age=14400; SameSite=Lax${secure}`;
      await onUnlocked();
    } catch (cause) {
      if (request.current !== controller) return;
      setState({
        status: "error",
        message:
          cause instanceof Error
            ? cause.message
            : "Could not verify the PIN right now. Try again.",
        occurredAt: Date.now(),
      });
    } finally {
      controller.abort();
      if (request.current === controller) {
        request.current = null;
        setState((current) =>
          current.status === "verifying" ? { status: "idle" } : current,
        );
      }
    }
  };

  const changePin = (value: string) => {
    request.current?.abort();
    request.current = null;
    setPin(value);
    setState({ status: "idle" });
  };
  return {
    pin,
    state,
    submitting,
    verify,
    changePin,
    reset: () => changePin(""),
  };
}
