import { describe, expect, it } from "vitest";
import { getNotificationDestination } from "../notification-destination";

describe("notification destinations", () => {
  it("routes dashboard and incident assignments", () => {
    expect(getNotificationDestination("dashboard/tech-manager")).toEqual({ kind: "tech-manager" });
    expect(getNotificationDestination("production/incidents?incident=fault-12")).toEqual({ kind: "incident", incident: "fault-12" });
  });

  it("routes native rooms and canonical direct messages", () => {
    expect(getNotificationDestination("chat?room=production")).toEqual({ kind: "chat", room: "production" });
    expect(getNotificationDestination("chat?room=dm%3Aalice%3Abob")).toEqual({ kind: "chat", room: "dm:alice:bob" });
  });

  it("rejects malformed, external, and non-canonical destinations", () => {
    expect(getNotificationDestination("https://example.com")).toBeNull();
    expect(getNotificationDestination("chat?room=dm%3Abob%3Aalice")).toBeNull();
    expect(getNotificationDestination("chat?room=unknown")).toBeNull();
    expect(getNotificationDestination("")).toBeNull();
  });
});
