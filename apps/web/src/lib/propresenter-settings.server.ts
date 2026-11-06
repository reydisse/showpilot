import { readSettingValuesForUse } from "./credential-settings.server";

export interface ProPresenterSettings {
  host: string;
  stagePort: number;
  apiPort: number;
  password: string;
  cuesEnabled: boolean;
  stageDisplayEnabled: boolean;
}

interface SettingsDatabase {
  prepare(sql: string): { bind(...values: unknown[]): { all<T>(): Promise<{ results?: T[] }> } };
}

/** Authorized internal consumers only. Never return this object to a browser or webview. */
export async function readProPresenterSettings(db: SettingsDatabase, orgId: string, encryptionKeys?: string): Promise<ProPresenterSettings> {
  const result = await db.prepare(`SELECT key, value FROM app_setting WHERE orgId=? AND key IN (
    'propresenter-host','propresenter-port','propresenter-api-port','propresenter-password',
    'propresenter-send-cues','propresenter-stage-display')`).bind(orgId).all<{ key: string; value: string }>();
  const values = await readSettingValuesForUse(encryptionKeys, orgId, result.results ?? []);
  const port = (value: string | undefined, fallback: number) => {
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed > 0 && parsed <= 65535 ? parsed : fallback;
  };
  return {
    host: values["propresenter-host"]?.trim() ?? "",
    stagePort: port(values["propresenter-port"], 50001),
    apiPort: port(values["propresenter-api-port"], 1025),
    password: values["propresenter-password"] ?? "",
    cuesEnabled: values["propresenter-send-cues"] === "true",
    stageDisplayEnabled: values["propresenter-stage-display"] === "true",
  };
}

export function proPresenterConnection(settings: ProPresenterSettings) {
  return {
    type: "connect-device" as const,
    protocol: "propresenter" as const,
    target: `propresenter:${settings.host}:${settings.stagePort}`,
    settings: { host: settings.host, port: settings.stagePort, apiPort: settings.apiPort, password: settings.password },
  };
}
