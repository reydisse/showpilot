import type { TransportType, ConnectivityMode, AdapterField } from "../types";

/**
 * A protocol driver handles raw transport and command format.
 * It does NOT know about specific devices — only how to send/receive
 * data over a particular protocol.
 */
export interface ProtocolDriver {
  /** Unique protocol identifier */
  readonly protocolId: string;
  /** Transport type */
  readonly transport: TransportType;
  /** Whether browser can use this directly */
  readonly connectivity: ConnectivityMode;
  /** Base config fields all devices on this protocol need */
  readonly baseConfigFields: AdapterField[];

  /** Open the transport connection */
  connect(settings: Record<string, unknown>): Promise<void>;
  /** Close the transport */
  disconnect(): void;
  /** Send a raw command, optionally return response */
  sendCommand(command: string): Promise<string | void>;
  /** Listen for unsolicited events. Returns unsubscribe. */
  onEvent(callback: (eventName: string, data: string) => void): () => void;
  /** Connection state */
  isConnected(): boolean;
}

/** Factory function to create a protocol driver instance */
export type ProtocolDriverFactory = (
  settings: Record<string, unknown>
) => ProtocolDriver;
