import type { D1Migration } from "cloudflare:test";

declare global {
  namespace Cloudflare {
    interface Env {
      TEST_MIGRATIONS: D1Migration[];
      BRIDGE_RELAY: DurableObjectNamespace<import("./src/durable-objects/BridgeRelay").BridgeRelay>;
    }
  }
}

export {};
