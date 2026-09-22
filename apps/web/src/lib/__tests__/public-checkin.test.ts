import { describe, expect, it } from "vitest";
import { applyPublicAttendanceIntent } from "../public-checkin";

function fixture(initialOnline = false) {
  const state = {
    memberId: "TD3917",
    name: "Taylor Director",
    photoUrl: "",
    role: "Technical Director",
    isOnline: initialOnline,
    lastCheckIn: null as Date | null,
    lastCheckOut: null as Date | null,
  };
  const store = {
    crewMember: {
      async updateMany(input: {
        where: { orgId: string; memberId: string; isOnline: boolean };
        data: { isOnline: boolean; lastCheckIn?: Date; lastCheckOut?: Date };
      }) {
        if (input.where.orgId !== "org-1" || input.where.memberId !== state.memberId || state.isOnline !== input.where.isOnline) {
          return { count: 0 };
        }
        state.isOnline = input.data.isOnline;
        if (input.data.lastCheckIn) state.lastCheckIn = input.data.lastCheckIn;
        if (input.data.lastCheckOut) state.lastCheckOut = input.data.lastCheckOut;
        return { count: 1 };
      },
      async findUnique() {
        return state;
      },
    },
  };
  return { state, store };
}

describe("public check-in intent", () => {
  it("makes a replayed check-in a no-op without replacing the timestamp", async () => {
    const { state, store } = fixture();
    const firstAt = new Date("2026-09-21T12:00:00.000Z");
    const retryAt = new Date("2026-09-21T12:05:00.000Z");

    await applyPublicAttendanceIntent(store, { orgId: "org-1", memberId: state.memberId, intent: "check-in", now: firstAt });
    await applyPublicAttendanceIntent(store, { orgId: "org-1", memberId: state.memberId, intent: "check-in", now: retryAt });

    expect(state.isOnline).toBe(true);
    expect(state.lastCheckIn).toEqual(firstAt);
  });

  it("applies an explicit check-out once and preserves that timestamp on retry", async () => {
    const { state, store } = fixture(true);
    const firstAt = new Date("2026-09-21T18:00:00.000Z");

    await applyPublicAttendanceIntent(store, { orgId: "org-1", memberId: state.memberId, intent: "check-out", now: firstAt });
    await applyPublicAttendanceIntent(store, { orgId: "org-1", memberId: state.memberId, intent: "check-out", now: new Date("2026-09-21T18:01:00.000Z") });

    expect(state.isOnline).toBe(false);
    expect(state.lastCheckOut).toEqual(firstAt);
  });
});
