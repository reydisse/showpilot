import handler from "@tanstack/react-start/server-entry";

// Durable Objects will be exported here in Phase 4
// export { RealtimeHub } from "./durable-objects/realtime-hub";

export default {
  fetch: handler.fetch,
};
