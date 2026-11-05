export declare const BRIDGE_TARGET_PROTOCOLS: readonly ["atem", "dmx-artnet", "dmx-sacn", "http-command", "obs", "osc", "pjlink", "propresenter", "tcp-command", "udp", "visca-ip", "wol"];
export type BridgeTargetProtocol = typeof BRIDGE_TARGET_PROTOCOLS[number];
export interface BridgeEndpoint {
    host: string;
    port: number;
    protocol: BridgeTargetProtocol;
}
export declare class BridgeTargetError extends Error {
    readonly code: "invalid-target" | "target-override" | "unapproved-target";
    constructor(code: "invalid-target" | "target-override" | "unapproved-target");
}
/** Normalize the host only: no credentials, scheme, path, port, wildcard or URL suffix. */
export declare function normalizeBridgeHost(value: unknown): string;
export declare function parseBridgeEndpoint(input: unknown): BridgeEndpoint;
/** Enumerate actual destinations, including PP's API fallback, before any Bridge dispatch. */
export declare function resolveBridgeEndpoints(input: unknown): BridgeEndpoint[];
