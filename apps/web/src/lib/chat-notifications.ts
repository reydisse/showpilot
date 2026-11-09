import {
  chatNotificationResultSchema,
  type ChatNotificationCommand,
} from "@showpilot/shared/chat-notification";
import { runRouteLoad } from "./route-load-deadlines";

export type ChatNotificationWork = {
  command: ChatNotificationCommand;
  label: string;
  at: number;
  status: "pending" | "failed";
};
type Scope = { orgId: string; userId: string; roomId: string };

/** One writer per browser-session scope. A replacement chat adapter subscribes
 * to the same jobs while old requests settle, without resending their messages. */
class ChatNotifications {
  private work: ChatNotificationWork[] = [];
  private listeners = new Set<(work: ChatNotificationWork[]) => void>();
  constructor(private scope: Scope) {}
  subscribe(listener: (work: ChatNotificationWork[]) => void) {
    this.listeners.add(listener);
    listener(this.work);
    return () => {
      this.listeners.delete(listener);
    };
  }
  private update(work: ChatNotificationWork[]) {
    this.work = work;
    for (const listener of this.listeners) listener(work);
  }
  submit(command: ChatNotificationCommand, label: string) {
    if (
      command.orgId !== this.scope.orgId ||
      command.userId !== this.scope.userId ||
      command.roomId !== this.scope.roomId ||
      this.work.some((item) => item.command.requestId === command.requestId)
    )
      return;
    const item: ChatNotificationWork = {
      command,
      label,
      at: Date.now(),
      status: "pending",
    };
    this.update([...this.work, item]);
    this.send(item);
  }
  retry(requestId: string) {
    const previous = this.work.find(
      (item) => item.command.requestId === requestId,
    );
    if (previous?.status !== "failed") return;
    const next: ChatNotificationWork = {
      ...previous,
      status: "pending",
      at: Date.now(),
    };
    this.update(this.work.map((item) => (item === previous ? next : item)));
    this.send(next);
  }
  private send(item: ChatNotificationWork) {
    const { userId, ...command } = item.command;
    void runRouteLoad(
      async (controller) => {
        const endpoint =
          command.kind === "message" ? "notify" : "reaction-notify";
        const response = await fetch(
          `/api/mobile/v1/chat/${endpoint}?orgId=${encodeURIComponent(command.orgId)}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ...command, expectedUserId: userId }),
            signal: controller.signal,
          },
        );
        if (!response.ok)
          throw new Error("Crew notification was not confirmed.");
        const result = chatNotificationResultSchema.parse(
          await response.json(),
        );
        if (
          result.orgId !== command.orgId ||
          result.userId !== userId ||
          result.roomId !== command.roomId ||
          result.messageId !== command.messageId ||
          result.requestId !== command.requestId
        )
          throw new Error("Notification reply belongs to another request.");
      },
      undefined,
      15_000,
    )
      .then(() => {
        this.update(this.work.filter((current) => current !== item));
      })
      .catch(() => {
        this.update(
          this.work.map((current) =>
            current === item
              ? { ...item, status: "failed", at: Date.now() }
              : current,
          ),
        );
      });
  }
}
// Created by browser chat adapters, never during server rendering. Keys include
// the actual actor, organization and room; no other account inherits a retry.
const queues = new Map<string, ChatNotifications>();
export function chatNotifications(scope: Scope) {
  const key = JSON.stringify([scope.userId, scope.orgId, scope.roomId]);
  let queue = queues.get(key);
  if (!queue) {
    queue = new ChatNotifications(scope);
    queues.set(key, queue);
  }
  return queue;
}
