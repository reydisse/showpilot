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
    if (new URL(request.url).pathname === "/test/delay") {
      const delay = Number(await request.text());
      if (!Number.isInteger(delay) || delay < 0 || delay > 2000) return new Response("Invalid test delay", { status: 400 });
      await this.ctx.storage.put("test-delay", delay);
      return new Response("Configured");
    }
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
    if (new URL(request.url).pathname === "/trigger") {
      const delay = await this.ctx.storage.get<number>("test-delay");
      if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    }
    return super.fetch(request);
  }
}

export default {
  fetch(): Response {
    return new Response("Worker test entrypoint", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
