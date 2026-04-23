export interface Member {
  id: string;
  orgId: string;
  memberId: string;
  name: string;
  role: string;
  photoUrl: string;
  isOnline: boolean;
  lastCheckIn: string | null;
  lastCheckOut: string | null;
  createdAt: string;
}

export type MemberFormData = {
  memberId: string;
  name: string;
  role: string;
  photoFile?: File | null;
  photoUrl?: string;
};

/* -- Role categories for grouped team views -- */

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

export interface DepartmentConfig {
  label: string;
  color: string;
  /** Exact-match roles (case-insensitive) */
  roles: string[];
  /** Substring patterns -- if the role *contains* any of these, it matches (case-insensitive) */
  patterns?: string[];
}

export const DEPARTMENTS: Record<RoleDepartment, DepartmentConfig> = {
  leadership: {
    label: "Leadership",
    color: "bg-fire-500/15 text-fire-400 border-fire-500/25",
    roles: ["Media Pastor", "Lead Pastor", "Executive Pastor", "Technical Director"],
    patterns: ["director", "pastor"],
  },
  production: {
    label: "Production",
    color: "bg-orange-500/15 text-orange-400 border-orange-500/25",
    roles: ["Stage Manager", "Stage Hand", "Show Caller", "Production Manager", "Floor Manager"],
    patterns: ["producer", "production"],
  },
  camera: {
    label: "Camera",
    color: "bg-purple-500/15 text-purple-400 border-purple-500/25",
    roles: ["Camera Operator", "Video Switcher", "Jib Operator", "Camera Shader"],
    patterns: ["camera"],
  },
  audio: {
    label: "Audio",
    color: "bg-blue-500/15 text-blue-400 border-blue-500/25",
    roles: [
      "Sound Tech",
      "Audio Engineer",
      "FOH Engineer",
      "Monitor Engineer",
      "Broadcast Audio",
      "A1",
      "A2",
    ],
    patterns: ["audio", "sound", "foh", "monitor eng"],
  },
  visuals: {
    label: "Visuals",
    color: "bg-pink-500/15 text-pink-400 border-pink-500/25",
    roles: ["Lyrics/Slides", "Graphics", "ProPresenter", "Media Shout"],
    patterns: ["lyrics", "slides", "graphic", "propresenter"],
  },
  lighting: {
    label: "Lighting",
    color: "bg-yellow-500/15 text-yellow-400 border-yellow-500/25",
    roles: ["Lighting", "Lighting Designer", "Spot Operator"],
    patterns: ["lighting", "spot op"],
  },
  streaming: {
    label: "Streaming",
    color: "bg-green-500/15 text-green-400 border-green-500/25",
    roles: ["Stream Tech", "Broadcast Engineer"],
    patterns: ["stream", "broadcast"],
  },
  technical: {
    label: "Technical",
    color: "bg-cyan-500/15 text-cyan-400 border-cyan-500/25",
    roles: ["Technical Manager", "Tech Lead"],
    patterns: ["tech manager", "technical"],
  },
  other: {
    label: "Other",
    color: "bg-board-border text-board-muted border-board-border",
    roles: [],
  },
};

const DEPARTMENT_PRIORITY: RoleDepartment[] = [
  "leadership",
  "production",
  "camera",
  "audio",
  "visuals",
  "lighting",
  "streaming",
  "technical",
];

export function getDepartment(role: string): RoleDepartment {
  const lower = role.toLowerCase().trim();

  // 1. Exact match (case-insensitive)
  for (const dept of DEPARTMENT_PRIORITY) {
    const config = DEPARTMENTS[dept];
    if (config.roles.some((r) => r.toLowerCase() === lower)) return dept;
  }

  // 2. Pattern / substring match
  for (const dept of DEPARTMENT_PRIORITY) {
    const config = DEPARTMENTS[dept];
    if (config.patterns?.some((p) => lower.includes(p.toLowerCase()))) return dept;
  }

  return "other";
}
