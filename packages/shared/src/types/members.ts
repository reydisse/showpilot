export type RoleDepartment =
  | "camera"
  | "audio"
  | "visuals"
  | "lighting"
  | "streaming"
  | "production"
  | "leadership"
  | "technical"
  | "other";

export interface CrewMember {
  id: string;
  memberId: string;
  name: string;
  role: string;
  photoUrl: string;
  isOnline: boolean;
  lastCheckIn: string | null;
  lastCheckOut: string | null;
  createdAt: string;
}
