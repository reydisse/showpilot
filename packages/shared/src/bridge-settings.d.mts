export interface BridgeSettingsBinding {
  orgId: string;
  installationId: string;
  protocol: string;
  target: string;
}
export interface ProtectedBridgeSettings {
  version: 1;
  keyId: string;
  nonce: string;
  expiresAt: number;
  iv: string;
  wrappedKey: string;
  ciphertext: string;
}
export interface BridgeSettingsRecipient {
  readonly publicKey: string;
  open(value: unknown, context: BridgeSettingsBinding): Promise<Record<string, unknown>>;
}
export declare function importBridgeSettingsKey(encoded: unknown): Promise<{ key: CryptoKey; keyId: string }>;
export declare function sealBridgeSettings(recipient: string, context: BridgeSettingsBinding, settings: Record<string, unknown>): Promise<ProtectedBridgeSettings>;
export declare function createBridgeSettingsRecipient(): Promise<BridgeSettingsRecipient>;
