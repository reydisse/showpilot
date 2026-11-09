import { z } from "zod";
import { WORKSPACE_SETTING_KEYS } from "@showpilot/shared";
import { RUNDOWN_PIN_SETTING_KEY } from "./rundown-pin";
import type { Permission } from "./permissions";

// app_setting also holds live state, access controls and operation receipts.
// Only these operator-editable fields belong to the generic Settings API.
// Workspace and schedule-provider configuration have dedicated commands.
const EDITABLE_SETTING_PERMISSIONS = {
  "org-timezone": "settings:organization",
  "chat-adapter": "settings:integrations",
  "rundown-adapter": "settings:integrations",
  "lyrics-output": "settings:integrations",
  "slack-token": "settings:integrations",
  "slack-channel": "settings:integrations",
  "slack-signing-secret": "settings:integrations",
  "mattermost-url": "settings:integrations",
  "mattermost-token": "settings:integrations",
  "mattermost-channel": "settings:integrations",
  "teams-webhook-url": "settings:integrations",
  "discord-bot-token": "settings:integrations",
  "discord-channel-id": "settings:integrations",
  "ontime-url": "settings:integrations",
  "ontime-sync-rundown": "settings:integrations",
  "ontime-send-commands": "settings:integrations",
  "propresenter-host": "settings:integrations",
  "propresenter-port": "settings:integrations",
  "propresenter-api-port": "settings:integrations",
  "propresenter-password": "settings:integrations",
  "propresenter-pull-order": "settings:integrations",
  "propresenter-send-cues": "settings:integrations",
  "default-call-lead-minutes": "settings:production_defaults",
  "default-countdown-minutes": "settings:production_defaults",
  "default-timer-mode": "settings:production_defaults",
  "clock-format": "settings:production_defaults",
  "timezone-display": "settings:production_defaults",
  "overtime-behavior": "settings:production_defaults",
  "default-confidence-layout": "settings:production_defaults",
  "l3-default-style": "settings:lowerthird_config",
  "l3-animation-speed": "settings:lowerthird_config",
  "l3-auto-clear": "settings:lowerthird_config",
  "l3-auto-clear-duration": "settings:lowerthird_config",
  "notify-app-chat": "settings:notifications",
  "webhook-url": "settings:webhooks",
} satisfies Record<string, Permission>;

export const EDITABLE_SETTING_KEYS = Object.keys(EDITABLE_SETTING_PERMISSIONS);

export function isEditableSettingKey(key: string): key is keyof typeof EDITABLE_SETTING_PERMISSIONS {
  return Object.hasOwn(EDITABLE_SETTING_PERMISSIONS, key);
}

export function permissionForSettingKey(key: string): Permission {
  if (!isEditableSettingKey(key)) throw new Error("Choose a supported organization setting.");
  return EDITABLE_SETTING_PERMISSIONS[key];
}

export const genericSettingKeySchema = z.string().min(1).max(100)
  .refine(key => key !== RUNDOWN_PIN_SETTING_KEY, "Use the dedicated rundown PIN control.")
  .refine(key => key !== "api-key", "Use Bridge installation credentials.")
  .refine(key => !WORKSPACE_SETTING_KEYS.includes(key), "Use Workspace settings to change names and features.")
  .refine(isEditableSettingKey, "Choose a supported organization setting.");
