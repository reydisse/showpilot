import type { AutomationActionType, AutomationEvent } from "@/types/timecode";
import { automationDeviceId } from "./automation-timing";

export function isTriggerControlAction(action: AutomationActionType): action is "triggers-disable" | "triggers-enable" {
  return action === "triggers-disable" || action === "triggers-enable";
}

/** Actions sharing an output stay ordered; unrelated outputs can run together. */
export function automationOutput(event: AutomationEvent): string {
  switch (event.action) {
    case "lower-third-show":
    case "lower-third-clear": return "graphics";
    case "lyrics-goto":
    case "lyrics-next-section":
    case "lyrics-previous-section":
    case "lyrics-clear": return "lyrics";
    case "rundown-advance":
    case "rundown-start-item":
    case "rundown-goto-item":
    case "rundown-previous":
    case "rundown-pause":
    case "rundown-resume":
    case "rundown-stop":
    case "rundown-adjust":
    case "stage-message":
    case "stage-clear": return "rundown";
    case "crew-message": return "production-chat";
    case "triggers-disable":
    case "triggers-enable": return "automation-control";
    case "pp-trigger-slide":
    case "pp-trigger-next":
    case "pp-trigger-previous":
    case "pp-trigger-prop":
    case "pp-clear-props":
    case "pp-trigger-clear": return "propresenter";
    case "device-action":
    case "lighting-scene":
    case "lighting-blackout": {
      const id = event.timingDeviceId ?? automationDeviceId(event);
      return `device:${id ?? "unresolved"}`;
    }
    case "custom-webhook": return `webhook:${event.payload.url}`;
    default: {
      const unsupported: never = event.action;
      throw new Error(`Unsupported automation action: ${unsupported}`);
    }
  }
}

export class AutomationExecutor {
  private readonly pending = new Map<string, Promise<void>>();

  async run(output: string, timeoutMs: number, action: (signal: AbortSignal) => Promise<void>): Promise<void> {
    const controller = new AbortController();
    const previous = this.pending.get(output) ?? Promise.resolve();
    const operation = previous.then(() => {
      controller.signal.throwIfAborted();
      return action(controller.signal);
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const error = new Error(`Automation timed out after ${timeoutMs} ms. Check the output before retrying.`);
        controller.abort(error);
        reject(error);
      }, timeoutMs);
    });
    const result = Promise.race([operation, deadline]);
    // A rejected action must not poison later actions for this output.
    const settled = result.then(() => {}, () => {});
    this.pending.set(output, settled);
    try {
      await result;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      if (this.pending.get(output) === settled) this.pending.delete(output);
    }
  }
}
