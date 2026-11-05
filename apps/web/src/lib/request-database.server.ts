import { AsyncLocalStorage } from "node:async_hooks";
import { env } from "cloudflare:workers";

const POST_WRITE_COOKIE = "showpilot_read_after_write";
const POST_WRITE_WINDOW_MS = 15_000;
type ReadMode = "primary" | "replica" | "post-write";
interface DatabaseRequest {
  database: D1Database;
  mode: ReadMode;
  session?: D1DatabaseSession;
  wrote: boolean;
}

const requests = new AsyncLocalStorage<DatabaseRequest>();
const primaryQueries = new AsyncLocalStorage<boolean>();

export function databaseRequestKey(): object | undefined { return requests.getStore(); }

export function withDatabaseTask<T>(database: D1Database, task: () => Promise<T>): Promise<T> {
  return requests.run({ database, mode: "primary", wrote: false }, task);
}

function hasRecentWrite(request: Request): boolean {
  const value = request.headers.get("cookie")?.split(";")
    .map(part => part.trim()).find(part => part.startsWith(`${POST_WRITE_COOKIE}=`))?.slice(POST_WRITE_COOKIE.length + 1);
  if (!value || !/^\d{13}$/.test(value)) return false;
  const age = Date.now() - Number(value);
  return age >= 0 && age < POST_WRITE_WINDOW_MS;
}

function databaseForQuery(): D1Database | D1DatabaseSession {
  const request = requests.getStore();
  const database = request?.database ?? env.DB;
  if (!request || request.mode === "primary" || request.wrote || primaryQueries.getStore()) return database;
  request.session ??= database.withSession(request.mode === "post-write" ? "first-primary" : "first-unconstrained");
  return request.session;
}

export function withPrimaryDatabase<T>(query: () => Promise<T>): Promise<T> {
  return primaryQueries.run(true, query);
}

export function markDatabaseWrite(): void {
  const request = requests.getStore();
  if (request) request.wrote = true;
}

/** Stateless adapter binding: only the request owns a D1 session or statement. */
export const requestDatabase: D1Database = {
  prepare: sql => databaseForQuery().prepare(sql),
  batch: statements => databaseForQuery().batch(statements),
  exec: sql => (requests.getStore()?.database ?? env.DB).exec(sql),
  dump: () => (requests.getStore()?.database ?? env.DB).dump(),
  withSession: constraint => (requests.getStore()?.database ?? env.DB).withSession(constraint),
};

export async function withDatabaseRequest(
  request: Request,
  database: D1Database,
  handle: () => Promise<Response>,
): Promise<Response> {
  const readOnly = request.method === "GET" || request.method === "HEAD";
  const upgrade = request.headers.get("upgrade")?.toLowerCase() === "websocket";
  const loader = !new URL(request.url).pathname.startsWith("/api/");
  const state: DatabaseRequest = {
    database,
    mode: !readOnly || upgrade ? "primary" : loader && hasRecentWrite(request) ? "post-write" : "replica",
    wrote: false,
  };
  return requests.run(state, async () => {
    const response = await handle();
    // Raw-D1 mutation routes also need a fresh loader after their redirect.
    if (!upgrade && response.status >= 200 && response.status < 400 && (state.wrote || !readOnly)) {
      const headers = new Headers(response.headers);
      const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
      headers.append("Set-Cookie", `${POST_WRITE_COOKIE}=${Date.now()}; Path=/; Max-Age=15; HttpOnly; SameSite=Lax${secure}`);
      return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
    }
    return response;
  });
}
