import { LocalShowManager } from "../../../bridge/src/local-show-manager";
import { parseLocalShowRequest } from "../../../bridge/src/local-show-control";
import type { PreparedLocalShow } from "../../../bridge/src/local-show-model";

/** Real native state machine with disposable storage and a counted fake device. */
export function localShowFixture() {
  let saved: unknown = null;
  let source = "cloud";
  let outputCount = 0;
  const preparation: PreparedLocalShow = {
    version: 1,
    sessionId: "local-session",
    orgId: "org-1",
    installationId: "installation-1",
    showId: "show-1",
    serviceDate: "2026-11-06",
    title: "Fixture service",
    baseRevision: 7,
    preparedAt: Date.now(),
    expiresAt: Date.now() + 3600000,
    items: ["first", "second"].map((id) => ({
      id,
      title: id,
      type: "segment",
      duration: 60000,
      notes: "",
      assignee: "",
      cue: "",
      status: "upcoming",
    })),
    timer: {
      playback: "stop",
      currentItemId: null,
      elapsed: 0,
      startedAt: null,
      pausedAt: null,
      mode: "count-down",
    },
    approvedTargets: [
      { protocol: "http-command", host: "127.0.0.1", port: 9999 },
    ],
    actions: [
      {
        id: "cue-1",
        label: "Camera cue",
        deviceId: "device-1",
        protocol: "http-command",
        target: "127.0.0.1:9999",
        command: "POST /cue",
        settings: { password: "fixture-private-password" },
      },
    ],
  };
  const manager = new LocalShowManager({
    store: {
      load: () => structuredClone(saved),
      save: (value) => {
        saved = structuredClone(value);
      },
    },
    scope: {
      orgId: preparation.orgId,
      installationId: preparation.installationId,
    },
    activate: async () => {
      source = "local";
    },
    deactivate: async () => {
      source = "cloud";
    },
    execute: async () => {
      outputCount++;
      return "acknowledged";
    },
  });
  const status = () => ({
    ...manager.status(),
    installationId: preparation.installationId,
    commandSource: source,
  });
  const invoke = async (request: unknown) => {
    const parsed = parseLocalShowRequest(request);
    if (!parsed) throw new Error("Invalid fixture native request");
    await manager.handle(parsed);
    return status();
  };
  return {
    preparation,
    manager,
    status,
    invoke,
    outputCount: () => outputCount,
    prepare: (input = preparation) =>
      manager.prepare(input, input.approvedTargets),
    finish: async () => {
      const sessionId = preparation.sessionId;
      await invoke({ operation: "begin", sessionId, confirmed: true });
      await invoke({
        operation: "transport",
        sessionId,
        expectedSequence: 0,
        requestId: "start-1",
        action: "timer-start",
        payload: { itemId: "first" },
      });
      await invoke({
        operation: "device",
        sessionId,
        expectedSequence: 1,
        requestId: "device-request",
        actionId: "cue-1",
        confirmed: true,
      });
      await invoke({
        operation: "transport",
        sessionId,
        expectedSequence: 2,
        requestId: "next-1",
        action: "timer-next",
      });
      await invoke({
        operation: "finish",
        sessionId,
        expectedSequence: 3,
        confirmed: true,
      });
    },
  };
}
