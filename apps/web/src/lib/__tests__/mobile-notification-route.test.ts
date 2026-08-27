import { describe, expect, it } from "vitest";
import { notificationRoute } from "../../../../mobile/src/lib/notification-route";

describe("mobile notification destinations", () => {
  it("maps operational destinations to native screens", () => {
    expect(notificationRoute("schedule?date=2026-08-22&assignment=a1")).toEqual({
      screen: "schedule",
      date: "2026-08-22",
      assignmentId: "a1",
    });
    expect(notificationRoute("production/incidents?incident=i1")).toEqual({ screen: "incidents" });
    expect(notificationRoute("dashboard/tech-manager")).toEqual({ screen: "devices" });
    expect(notificationRoute("show?showId=s1")).toEqual({ screen: "show", showId: "s1" });
    expect(notificationRoute("production/checklist?show=s1")).toEqual({ screen: "checklist", showId: "s1" });
    expect(notificationRoute("https://showpilot.tech/faithfire-production/schedule?assignment=a1")).toEqual({
      screen: "schedule",
      assignmentId: "a1",
    });
    expect(notificationRoute("schedule")).toEqual({ screen: "schedule" });
  });

  it("drops malformed schedule selections without losing the safe destination", () => {
    expect(notificationRoute("schedule?date=2026-02-31&assignment=")).toEqual({ screen: "schedule" });
    expect(notificationRoute(`schedule?assignment=${"a".repeat(65)}`)).toEqual({ screen: "schedule" });
  });

  it("accepts known chat rooms and canonical direct messages", () => {
    expect(notificationRoute("chat?room=planning")).toEqual({ screen: "chat", room: "planning" });
    expect(notificationRoute("chat?room=dm%3Aalice%3Abob")).toEqual({ screen: "chat", room: "dm:alice:bob" });
  });

  it("opens access-grant destinations on native feature surfaces", () => {
    expect(notificationRoute("rundown")).toEqual({ screen: "shows" });
    expect(notificationRoute("board")).toEqual({ screen: "shows" });
    expect(notificationRoute("production/incidents")).toEqual({ screen: "incidents" });
    expect(notificationRoute("dashboard/tech-manager")).toEqual({ screen: "devices" });
    for (const path of [
      "production/cue-sheets",
      "checkin",
      "timecode",
      "streaming/graphics",
      "streaming/health",
      "production/assets",
      "dashboard/prod-manager",
    ]) {
      expect(notificationRoute(path)).toEqual({ screen: "operations" });
    }
    expect(notificationRoute("production/checklist")).toEqual({ screen: "checklist" });
    expect(notificationRoute("https://showpilot.tech/faithfire-production/streaming/graphics")).toEqual({ screen: "operations" });
  });

  it("rejects unknown routes and non-canonical direct messages", () => {
    expect(notificationRoute("billing?checkout=evil")).toBeNull();
    expect(notificationRoute("chat?room=dm%3Abob%3Aalice")).toBeNull();
    expect(notificationRoute("https://evil.example/schedule?assignment=a1")).toBeNull();
  });
});
