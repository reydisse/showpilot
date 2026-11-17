export const DEVICE_COMMAND_SCHEMA_VERSION = 1;

export function parseDeviceCommand(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  // The sole intentional change from the Bridge parser: reject unsupported explicit versions.
  // An absent version retains the existing version 1 wire format.
  if (value.v !== undefined && value.v !== DEVICE_COMMAND_SCHEMA_VERSION) return null;
  if (value.type !== "command" || typeof value.id !== "string"
    || typeof value.protocol !== "string" || typeof value.target !== "string"
    || typeof value.command !== "string") return null;
  return { type: "command", id: value.id, protocol: value.protocol, target: value.target, command: value.command };
}
