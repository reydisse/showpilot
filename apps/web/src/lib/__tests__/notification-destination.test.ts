import { describe, expect, it } from "vitest";
import { getNotificationDestination } from "../notification-destination";

describe("notification destinations", () => {
  it("routes dashboard and incident assignments", () => {
    expect(getNotificationDestination("dashboard/tech-manager")).toEqual({ kind: "tech-manager" });
    expect(getNotificationDestination("production/incidents?incident=fault-12")).toEqual({ kind: "incident", incident: "fault-12", date: undefined, show: undefined });
    expect(getNotificationDestination("production/incidents?date=2026-08-18&show=show-9&incident=fault-12")).toEqual({ kind: "incident", incident: "fault-12", date: "2026-08-18", show: "show-9" });
  });

  it("routes native rooms and canonical direct messages", () => {
    expect(getNotificationDestination("chat?room=production")).toEqual({ kind: "chat", room: "production" });
    expect(getNotificationDestination("chat?room=dm%3Aalice%3Abob")).toEqual({ kind: "chat", room: "dm:alice:bob" });
  });

  it("routes service assignments to the selected schedule", () => {
    expect(getNotificationDestination("schedule?date=2026-08-23&assignment=assignment-12")).toEqual({
      kind: "schedule",
      date: "2026-08-23",
      assignment: "assignment-12",
    });
  });

  it("rejects malformed, external, and non-canonical destinations", () => {
    expect(getNotificationDestination("https://example.com")).toBeNull();
    expect(getNotificationDestination("chat?room=dm%3Abob%3Aalice")).toBeNull();
    expect(getNotificationDestination("chat?room=unknown")).toBeNull();
    expect(getNotificationDestination("")).toBeNull();
  });
});
