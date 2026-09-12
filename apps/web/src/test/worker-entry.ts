import { RundownRelay } from "../durable-objects/RundownRelay";

export { BridgeRelay } from "../durable-objects/BridgeRelay";
export { ChatRelay } from "../durable-objects/ChatRelay";

export class TestRundownRelay extends RundownRelay {}

export default {
  fetch(): Response {
    return new Response("Worker test entrypoint", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
