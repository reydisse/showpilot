import { RundownRelay } from "../durable-objects/RundownRelay";
import { TimecodeRelay } from "../durable-objects/TimecodeRelay";
import { LowerThirdsRelay } from "../durable-objects/LowerThirdsRelay";
import { CueSheetRelay } from "../durable-objects/CueSheetRelay";

export { BridgeRelay } from "../durable-objects/BridgeRelay";
export { ChatRelay } from "../durable-objects/ChatRelay";

// Hold one real D1 batch to exercise concurrent lifecycle requests deterministically.
export class TestRundownRelay extends RundownRelay {
  private readonly batchGate: { next?: Promise<void>; release?: () => void; waiting: boolean };

  constructor(ctx: DurableObjectState, bindings: Cloudflare.Env) {
    const gate: { next?: Promise<void>; release?: () => void; waiting: boolean } = { waiting: false };
    const database = new Proxy(bindings.DB, {
      get(target, property) {
        if (property === "batch") return async (statements: D1PreparedStatement[]) => {
          const pending = gate.next;
          gate.next = undefined;
          if (pending) {
            gate.waiting = true;
            await pending;
            gate.waiting = false;
          }
          return target.batch(statements);
        };
        const value: unknown = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    super(ctx, { ...bindings, DB: database });
    this.batchGate = gate;
  }

  holdNextBatch(): void {
    this.batchGate.next = new Promise<void>(resolve => { this.batchGate.release = resolve; });
  }
  isBatchWaiting(): boolean { return this.batchGate.waiting; }
  releaseBatch(): void { this.batchGate.release?.(); }
}
export class TestTimecodeRelay extends TimecodeRelay {
  private readonly queries: { count: number; lyricsDelay: number; lyricsLookups: number };

  constructor(ctx: DurableObjectState, bindings: Cloudflare.Env) {
    const queries = { count: 0, lyricsDelay: 0, lyricsLookups: 0 };
    const database = new Proxy(bindings.DB, {
      get(target, property) {
        if (property === "prepare") return (sql: string) => {
          queries.count += 1;
          const statement = target.prepare(sql);
          if (!sql.includes("FROM song_section AS section JOIN song")) return statement;
          const wrap = (statement: D1PreparedStatement): D1PreparedStatement => new Proxy(statement, {
            get(target, property) {
              if (property === "bind") return (...values: unknown[]) => wrap(target.bind(...values));
              if (property === "all") return async () => {
                queries.lyricsLookups++;
                if (queries.lyricsDelay) await new Promise(resolve => setTimeout(resolve, queries.lyricsDelay));
                return target.all();
              };
              const value: unknown = Reflect.get(target, property, target);
              return typeof value === "function" ? value.bind(target) : value;
            },
          });
          return wrap(statement);
        };
        const value: unknown = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    super(ctx, { ...bindings, DB: database });
    this.queries = queries;
  }

  getQueryCount(): number { return this.queries.count; }
  setLyricsLookupDelay(milliseconds: number): void { this.queries.lyricsDelay = milliseconds; }
  getLyricsLookupCount(): number { return this.queries.lyricsLookups; }
}

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
    if (new URL(request.url).pathname === "/internal/trigger") {
      const delay = await this.ctx.storage.get<number>("test-delay");
      if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    }
    return super.fetch(request);
  }
}

// Keep real authorization, sockets and revision storage. Inject only the
// broadcast outage; readers can still reconnect and inspect confirmed state.
export class TestCueSheetRelay extends CueSheetRelay {
  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === "/test/status") {
      const status = Number(await request.text());
      if (!Number.isInteger(status) || status < 200 || status > 599) return new Response("Invalid test status", { status: 400 });
      await this.ctx.storage.put("test-status", status);
      return new Response("Configured");
    }
    if (path === "/broadcast") {
      const status = await this.ctx.storage.get<number>("test-status");
      if (status && status >= 400) return new Response("Injected cue-sheet broadcast failure", { status });
    }
    return super.fetch(request);
  }
}

const prismaIds = new WeakMap<object, number>();
let nextPrismaId = 0;
let sharedPrismaProbe: ReturnType<typeof import("../lib/db").getPrisma> | undefined;

export default {
  async fetch(request: Request, bindings: Env): Promise<Response> {
    if (new URL(request.url).pathname.startsWith("/api/auth/")) {
      const { getAuth } = await import("../lib/auth");
      const { withDatabaseRequest } = await import("../lib/request-database.server");
      return withDatabaseRequest(request, bindings.DB, () => getAuth().handler(request));
    }
    if (new URL(request.url).pathname === "/_test/prisma") {
      const { getPrisma } = await import("../lib/db");
      const { withDatabaseRequest } = await import("../lib/request-database.server");
      const queries: string[] = [];
      const sessions: string[] = [];
      const database = new Proxy(bindings.DB, {
        get(target, property) {
          if (property === "prepare") return (sql: string) => { queries.push("primary"); return target.prepare(sql); };
          if (property === "withSession") return (constraint: D1SessionConstraint) => {
            sessions.push(constraint);
            const session = target.withSession(constraint);
            return new Proxy(session, {
              get(target, property) {
                if (property === "prepare") return (sql: string) => { queries.push(constraint); return target.prepare(sql); };
                const value: unknown = Reflect.get(target, property, target);
                return typeof value === "function" ? value.bind(target) : value;
              },
            });
          };
          const value: unknown = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      return withDatabaseRequest(request, database, async () => {
        const prisma = Reflect.get(bindings, "TEST_SHARE_PRISMA") === true
          ? sharedPrismaProbe ??= getPrisma()
          : getPrisma();
        let clientId = prismaIds.get(prisma);
        if (!clientId) { clientId = ++nextPrismaId; prismaIds.set(prisma, clientId); }
        const url = new URL(request.url);
        const id = url.searchParams.get("orgId") ?? "";
        if (request.method === "POST") await prisma.organization.update({ where: { id }, data: { name: "Saved by fixture" } });
        const first = await prisma.organization.findUnique({ where: { id }, select: { id: true, name: true } });
        if (url.searchParams.has("lazyWrite")) await prisma.organization.update({ where: { id }, data: { name: "Seeded during GET" } });
        // Interleave another HTTP request while reusing this request's session.
        await new Promise(resolve => setTimeout(resolve, 10));
        if (url.searchParams.has("sessionId")) await prisma.session.findUnique({ where: { id: url.searchParams.get("sessionId") ?? "" } });
        const second = await prisma.organization.findUnique({ where: { id }, select: { id: true, name: true } });
        return Response.json({ first, second, clientId, reusedWithinRequest: getPrisma() === prisma, sessions, queries }, { headers: { "Set-Cookie": "fixture_cookie=kept; Path=/" } });
      });
    }
    return new Response("Worker test entrypoint", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
