export type InvitationSummary = {
  id: string;
  organization: { id: string; name: string; slug: string };
  role: string;
  expiresAt: number;
};
export type InvitationView =
  | { status: "signed-out" }
  | { status: "unavailable" }
  | { status: "unverified"; email: string }
  | { status: "wrong-account"; email: string }
  | { status: "pending" | "accepted" | "declined" | "canceled" | "expired" | "access-removed"; email: string; invitation: InvitationSummary };
