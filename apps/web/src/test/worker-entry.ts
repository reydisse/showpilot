import { RundownRelay } from "../durable-objects/RundownRelay";
import { TimecodeRelay } from "../durable-objects/TimecodeRelay";
import { LowerThirdsRelay } from "../durable-objects/LowerThirdsRelay";

export { BridgeRelay } from "../durable-objects/BridgeRelay";
export { ChatRelay } from "../durable-objects/ChatRelay";

export class TestRundownRelay extends RundownRelay {}
export class TestTimecodeRelay extends TimecodeRelay {}

// Fault injection exists only in the isolated Worker test entrypoint.
// Successful requests still run the production relay and its persistence.
export class TestLowerThirdsRelay extends LowerThirdsRelay {
  async fetch(request: Request): Promise<Response> {
    if (new URL(request.url).pathname === "/test/status") {
      const status = Number(await request.text());
      if (!Number.isInteger(status) || status < 200 || status > 599) {
        return new Response("Invalid test status", { status: 400 });
      }
      await this.ctx.storage.put("test-status", status);
      return new Response("Configured");
    }
    const status = await this.ctx.storage.get<number>("test-status");
    if (status && status >= 400) return new Response("Injected downstream failure", { status });
    return super.fetch(request);
  }
}

export default {
  fetch(): Response {
    return new Response("Worker test entrypoint", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
