export type AttendanceIntent = "check-in" | "check-out";

export interface PublicCrewMember {
  memberId: string;
  name: string;
  photoUrl: string;
  role: string;
  isOnline: boolean;
}

interface PublicCheckInStore {
  crewMember: {
    updateMany(input: {
      where: { orgId: string; memberId: string; isOnline: boolean };
      data: { isOnline: boolean; lastCheckIn?: Date; lastCheckOut?: Date };
    }): Promise<{ count: number }>;
    findUnique(input: {
      where: { orgId_memberId: { orgId: string; memberId: string } };
    }): Promise<PublicCrewMember | null>;
  };
}

/**
 * Apply a public attendance command as explicit, retry-safe intent.
 * Replaying a successful command is a no-op and preserves its timestamp.
 */
export async function applyPublicAttendanceIntent(
  store: PublicCheckInStore,
  input: {
    orgId: string;
    memberId: string;
    intent: AttendanceIntent;
    now?: Date;
  },
): Promise<PublicCrewMember | null> {
  const desiredOnline = input.intent === "check-in";
  const now = input.now ?? new Date();
  await store.crewMember.updateMany({
    where: {
      orgId: input.orgId,
      memberId: input.memberId,
      isOnline: !desiredOnline,
    },
    data: {
      isOnline: desiredOnline,
      ...(desiredOnline ? { lastCheckIn: now } : { lastCheckOut: now }),
    },
  });
  return store.crewMember.findUnique({
    where: { orgId_memberId: { orgId: input.orgId, memberId: input.memberId } },
  });
}
