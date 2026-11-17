export declare const DEVICE_COMMAND_SCHEMA_VERSION: 1;
export interface DeviceCommand {
  type: "command";
  id: string;
  protocol: string;
  target: string;
  command: string;
}
export declare function parseDeviceCommand(value: unknown): DeviceCommand | null;
