import { DurableObject } from "cloudflare:workers";

export { BridgeRelay } from "../durable-objects/BridgeRelay";

export class TestRundownRelay extends DurableObject<Env> {
  fetch(): Response {
    return new Response(null, { status: 204 });
  }
}

export default {
  fetch(): Response {
    return new Response("Worker test entrypoint", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
