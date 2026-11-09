import type { AutomationActionType } from "@/types/timecode";
import { z } from "zod";

export const PROP_CLEAR_DELAY_MS = 200;
const propNameSchema = z.string().trim().min(1).max(200);
const resolvedPropSchema = z.object({ propUuid: z.string().min(1).max(200) });

export function proPresenterPayloadProblem(
  action: AutomationActionType,
  payload: Record<string, unknown>,
): string | null {
  if (
    action.startsWith("pp-") &&
    payload.target !== undefined &&
    (typeof payload.target !== "string" ||
      payload.target.trim().length > 300 ||
      (payload.target.trim() !== "" &&
        !payload.target.trim().startsWith("propresenter:")))
  ) {
    return "Choose a connected ProPresenter target address.";
  }
  if (
    action === "pp-trigger-prop" &&
    !propNameSchema.safeParse(payload.propName).success
  ) {
    return "Enter a ProPresenter prop name, up to 200 characters.";
  }
  return null;
}

function waitForProps(signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, PROP_CLEAR_DELAY_MS);
    signal.addEventListener("abort", abort, { once: true });
  });
}

/** One ordered output operation. Each acknowledged step has a distinct receipt ID. */
export async function runProPresenterCue({
  action,
  payload,
  send,
  signal,
  assertCanDispatch,
}: {
  action: AutomationActionType;
  payload: Record<string, unknown>;
  send: (
    command: Record<string, unknown>,
    step: string,
  ) => Promise<string | undefined>;
  signal: AbortSignal;
  assertCanDispatch: () => void;
}): Promise<void> {
  assertCanDispatch();
  switch (action) {
    case "pp-trigger-prop": {
      const propName = propNameSchema.parse(payload.propName);
      const response = await send(
        { action: "resolve-prop", propName },
        "resolve",
      );
      const prop = resolvedPropSchema.parse(JSON.parse(response ?? "null"));
      assertCanDispatch();
      await send({ action: "clear-props" }, "clear");
      await waitForProps(signal);
      assertCanDispatch();
      await send(
        { action: "trigger-prop", propUuid: prop.propUuid },
        "trigger",
      );
      return;
    }
    case "pp-clear-props":
      await send({ action: "clear-props" }, "command");
      return;
    case "pp-trigger-previous":
      await send({ action: "previous" }, "command");
      return;
    case "pp-trigger-next":
      await send({ action: "next" }, "command");
      return;
    case "pp-trigger-clear":
      await send({ action: "clear" }, "command");
      return;
    case "pp-trigger-slide":
      await send(
        {
          action: "trigger-slide",
          presentationUuid: payload.presentationUuid,
          slideIndex: payload.slideIndex,
        },
        "command",
      );
      return;
    default:
      throw new Error("This cue is not a ProPresenter action.");
  }
}
