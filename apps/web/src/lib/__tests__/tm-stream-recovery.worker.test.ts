import { env } from "cloudflare:workers";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { hashPassword } from "better-auth/crypto";
import { seedRelayMember } from "@/test/relay-fixtures";
import { getPrisma } from "../db";
import { getAuth } from "../auth";
import { runTmControl } from "../tm-operations";
import { writeTmStream, getTmStreamState } from "../tm-stream";
import { getStreamDestinations } from "../stream-destinations";
const auth = vi.hoisted(() => ({ cookie: "", ip: 0 }));
vi.mock("better-auth/tanstack-start", () => ({
  tanstackStartCookies: () => ({ id: "test-cookie-bridge" }),
}));
vi.mock("@tanstack/react-start/server", () => ({
  getRequestHeaders: () => new Headers({ Cookie: auth.cookie }),
  setResponseHeader: vi.fn(),
}));
vi.mock("@tanstack/react-start", () => {
  const builder = () => {
    let validate = (value: unknown) => value;
    const chain = {
      middleware: () => chain,
      inputValidator: (fn: typeof validate) => {
        validate = fn;
        return chain;
      },
      handler:
        (fn: (input: { data: unknown }) => unknown) =>
        async (input: { data: unknown }) =>
          fn({ data: validate(input.data) }),
      server: () => chain,
    };
    return chain;
  };
  return {
    createServerFn: builder,
    createMiddleware: builder,
    createServerOnlyFn: <T>(fn: T): T => fn,
  };
});

let authenticated: Awaited<ReturnType<typeof fixture>>;
beforeEach(async () => {
  auth.cookie = "";
  authenticated = await fixture();
});
async function fixture() {
  const { orgId, userId } = await seedRelayMember(crypto.randomUUID());
  const password = "Disposable-crew-password-92!";
  await getPrisma().account.create({
    data: {
      id: crypto.randomUUID(),
      issuer: "local:credential",
      accountId: userId,
      providerId: "credential",
      userId,
      password: await hashPassword(password),
    },
  });
  const login = await getAuth().handler(
    new Request("https://app.showpilot.tech/api/auth/sign-in/email", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "https://app.showpilot.tech",
        "cf-connecting-ip": `192.0.2.${++auth.ip}`,
      },
      body: JSON.stringify({ email: `${userId}@example.test`, password }),
    }),
  );
  expect(login.status).toBe(200);
  await login.arrayBuffer();
  auth.cookie = login.headers
    .getSetCookie()
    .map((cookie) => cookie.split(";")[0])
    .join("; ");
  const session = await getAuth().api.getSession({
    headers: new Headers({ Cookie: auth.cookie }),
    query: { disableCookieCache: true },
  });
  if (!session) throw new Error("Fixture session missing");
  return { orgId, userId, actor: { userId, sessionId: session.session.id } };
}

type Output = { uid: string; url: string; streamKey: string; enabled: boolean };
const binding = {
  account: env.CLOUDFLARE_ACCOUNT_ID,
  token: env.CLOUDFLARE_STREAM_API_TOKEN,
};
let providerOutputs: Map<string, Output>, inputId: string;
beforeEach(async () => {
  const { orgId } = authenticated;
  inputId = crypto.randomUUID();
  providerOutputs = new Map();
  await env.DB.prepare(
    "INSERT INTO live_input(id,orgId,name,cfInputId) VALUES(?,?,'Technical fixture input','tm-fixture-input')",
  )
    .bind(inputId, orgId)
    .run();
  await destination("first");
  env.CLOUDFLARE_ACCOUNT_ID = "fixture-account";
  env.CLOUDFLARE_STREAM_API_TOKEN = "fixture-token";
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, options) => {
    const url = new URL(String(input)),
      method = options?.method ?? "GET";
    expect(url.origin).toBe("https://api.cloudflare.com");
    expect(url.pathname).toContain(
      "/accounts/fixture-account/stream/live_inputs/tm-fixture-input/outputs",
    );
    if (method === "GET")
      return Response.json({
        success: true,
        result: [...providerOutputs.values()],
      });
    if (method === "POST") {
      const body = JSON.parse(String(options?.body)),
        output: Output = {
          uid: crypto.randomUUID(),
          url: body.url,
          streamKey: body.streamKey,
          enabled: body.enabled,
        };
      expect(output.enabled).toBe(false);
      providerOutputs.set(output.uid, output);
      return Response.json({ success: true, result: output });
    }
    const id = url.pathname.split("/").at(-1) ?? "";
    if (method === "PUT") {
      const output = providerOutputs.get(id);
      if (!output) return new Response(null, { status: 404 });
      output.enabled = JSON.parse(String(options?.body)).enabled;
      return Response.json({ success: true, result: output });
    }
    if (method === "DELETE") {
      providerOutputs.delete(id);
      return Response.json({ success: true });
    }
    throw new Error("Unexpected provider fixture call");
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  env.CLOUDFLARE_ACCOUNT_ID = binding.account;
  env.CLOUDFLARE_STREAM_API_TOKEN = binding.token;
});
async function destination(suffix: string) {
  const id = crypto.randomUUID();
  await env.DB.prepare(
    "INSERT INTO stream_destination(id,orgId,name,platform,rtmpUrl,streamKey,enabled,cfOutputId,liveInputId) VALUES(?,?,?,'custom',?,?,1,'','')",
  )
    .bind(
      id,
      authenticated.orgId,
      `Fixture ${suffix}`,
      `rtmp://${suffix}.invalid/live`,
      `${suffix}-fixture-key`,
    )
    .run();
  return id;
}
async function command() {
  const { orgId } = authenticated,
    rows = await getStreamDestinations({ data: { orgId } });
  return {
    orgId,
    action: "stream-live" as const,
    requestId: crypto.randomUUID(),
    liveInputId: inputId,
    targets: rows.map((row) => ({ id: row.id, version: row.outputVersion })),
  };
}
it("does not restart stopped outputs when a technical Go Live reply is retried", async () => {
  const data = await command();
  await writeTmStream({ data });
  expect([...providerOutputs.values()].some((output) => output.enabled)).toBe(
    true,
  );
  await writeTmStream({
    data: {
      orgId: authenticated.orgId,
      action: "stream-stop",
      requestId: crypto.randomUUID(),
      targets: data.targets,
    },
  });
  expect([...providerOutputs.values()].some((output) => output.enabled)).toBe(
    false,
  );
  await writeTmStream({ data });
  expect([...providerOutputs.values()].some((output) => output.enabled)).toBe(
    false,
  );
});
it("starts only the destinations reviewed in the technical confirmation", async () => {
  const data = await command();
  await destination("unreviewed");
  await writeTmStream({ data });
  expect(
    [...providerOutputs.values()]
      .filter((output) => output.enabled)
      .map((output) => output.url),
  ).toEqual(["rtmp://first.invalid/live"]);
});

it("rejects the legacy streaming RPC and commands without reviewed targets", async () => {
  await expect(
    runTmControl({
      data: { orgId: authenticated.orgId, action: "stream-live" },
    }),
  ).rejects.toThrow();
  const data = await command();
  await expect(
    writeTmStream({ data: { ...data, targets: [] } }),
  ).rejects.toThrow();
  await expect(
    writeTmStream({ data: { ...data, targets: undefined } }),
  ).rejects.toThrow();
  await expect(
    writeTmStream({ data: { ...data, requestId: undefined } }),
  ).rejects.toThrow();
  expect(fetch).not.toHaveBeenCalled();
});
it("binds a request ID to the original input and destination list", async () => {
  const data = await command();
  await writeTmStream({ data });
  const calls = vi.mocked(fetch).mock.calls.length;
  await expect(
    writeTmStream({ data: { ...data, liveInputId: crypto.randomUUID() } }),
  ).rejects.toThrow(/different output changes/);
  expect(vi.mocked(fetch).mock.calls).toHaveLength(calls);
});
it("rejects changed destination configuration before contacting the provider", async () => {
  const data = await command();
  await env.DB.prepare(
    "UPDATE stream_destination SET name='Changed after review' WHERE orgId=?",
  )
    .bind(authenticated.orgId)
    .run();
  await expect(writeTmStream({ data })).rejects.toThrow(/newer output command/);
  expect(fetch).not.toHaveBeenCalled();
});
it("rejects an input from another organization", async () => {
  const data = await command(),
    other = await seedRelayMember(crypto.randomUUID()),
    otherInput = crypto.randomUUID();
  await env.DB.prepare(
    "INSERT INTO live_input(id,orgId,name,cfInputId) VALUES(?,?,'Other input','other-provider-input')",
  )
    .bind(otherInput, other.orgId)
    .run();
  await expect(
    writeTmStream({ data: { ...data, liveInputId: otherInput } }),
  ).rejects.toThrow(/input changed/);
  expect(fetch).not.toHaveBeenCalled();
});
it("rejects an unavailable input without preparing any output intents", async () => {
  const data = await command();
  await env.DB.prepare(
    "UPDATE live_input SET cfInputId='pending:fixture' WHERE orgId=? AND id=?",
  )
    .bind(authenticated.orgId, inputId)
    .run();
  await expect(writeTmStream({ data })).rejects.toThrow(/input changed/);
  expect(fetch).not.toHaveBeenCalled();
  expect(
    await env.DB.prepare("SELECT * FROM stream_output_intent WHERE orgId=?")
      .bind(authenticated.orgId)
      .first(),
  ).toBeNull();
});
it("rechecks permissions before replaying a completed command", async () => {
  const data = await command();
  await writeTmStream({ data });
  await env.DB.prepare(
    "UPDATE member SET role='member' WHERE organizationId=? AND userId=?",
  )
    .bind(authenticated.orgId, authenticated.userId)
    .run();
  const calls = vi.mocked(fetch).mock.calls.length;
  await expect(writeTmStream({ data })).rejects.toThrow(/Forbidden/);
  expect(vi.mocked(fetch).mock.calls).toHaveLength(calls);
});
it("rejects deleted sessions even when the request carries an old cookie", async () => {
  const data = await command();
  await env.DB.prepare("DELETE FROM session WHERE id=?")
    .bind(authenticated.actor.sessionId)
    .run();
  await expect(writeTmStream({ data })).rejects.toThrow(/Sign in/);
  expect(fetch).not.toHaveBeenCalled();
});
it("rejects controls while the organization is being deleted", async () => {
  const data = await command();
  await env.DB.prepare(
    "INSERT INTO app_setting(id,orgId,key,value) VALUES(?,?,'organization-deleting','true')",
  )
    .bind(crypto.randomUUID(), authenticated.orgId)
    .run();
  await expect(writeTmStream({ data })).rejects.toThrow(/being deleted/);
  await expect(
    getTmStreamState({ data: { orgId: authenticated.orgId } }),
  ).rejects.toThrow(/being deleted/);
  expect(fetch).not.toHaveBeenCalled();
});
it("reports partial output failures and retries only unfinished destinations", async () => {
  await destination("second");
  const data = await command(),
    original = vi.mocked(fetch).getMockImplementation()!;
  let enabledRequests = 0;
  vi.mocked(fetch).mockImplementation(async (input, options) => {
    if (options?.method === "PUT") {
      enabledRequests++;
      if (enabledRequests === 1)
        return new Response("private-provider-detail", { status: 503 });
    }
    return original(input, options);
  });
  const first = await writeTmStream({ data });
  expect(first.results.filter((result) => !result.success)).toHaveLength(1);
  expect(first.results.filter((result) => result.success)).toHaveLength(1);
  expect(JSON.stringify(first)).not.toContain("private-provider-detail");
  expect(
    [...providerOutputs.values()].filter((output) => output.enabled),
  ).toHaveLength(1);
  const second = await writeTmStream({ data });
  expect(second.results.every((result) => result.success)).toBe(true);
  expect(enabledRequests).toBe(3);
  expect(providerOutputs.size).toBe(2);
});
it("reads provider enablement and preserves unknown status without returning credentials", async () => {
  const data = await command();
  await writeTmStream({ data });
  const output = [...providerOutputs.values()][0];
  output.enabled = false;
  const read = await getTmStreamState({ data: { orgId: authenticated.orgId } });
  expect(read.destinations[0].status).toBe("disabled");
  expect(read.inputs).toEqual([
    { id: inputId, name: "Technical fixture input" },
  ]);
  expect(JSON.stringify(read)).not.toContain("fixture-key");
  expect(JSON.stringify(read)).not.toContain("rtmp://");
  vi.mocked(fetch).mockResolvedValue(
    new Response("private-provider-error", { status: 500 }),
  );
  const failed = await getTmStreamState({
    data: { orgId: authenticated.orgId },
  });
  expect(failed.destinations[0].status).toBe("unknown");
  expect(JSON.stringify(failed)).not.toContain("private-provider-error");
});
it("fences an in-flight Go Live when Stop takes ownership", async () => {
  const data = await command(),
    original = vi.mocked(fetch).getMockImplementation()!;
  let release!: () => void, reached!: () => void;
  const held = new Promise<void>((resolve) => {
      release = resolve;
    }),
    created = new Promise<void>((resolve) => {
      reached = resolve;
    });
  vi.mocked(fetch).mockImplementation(async (input, options) => {
    const response = await original(input, options);
    if (options?.method === "POST") {
      reached();
      await held;
    }
    return response;
  });
  const live = writeTmStream({ data });
  await created;
  const stop = {
    orgId: authenticated.orgId,
    action: "stream-stop" as const,
    requestId: crypto.randomUUID(),
    targets: data.targets,
  };
  const stopping = await writeTmStream({ data: stop });
  expect(stopping.results.some((result) => !result.success)).toBe(true);
  release();
  await live;
  expect([...providerOutputs.values()].some((output) => output.enabled)).toBe(
    false,
  );
  expect(
    (await writeTmStream({ data: stop })).results.every(
      (result) => result.success,
    ),
  ).toBe(true);
  await writeTmStream({ data });
  expect(providerOutputs.size).toBe(0);
});

it("saves one technical notification per command across exact retries", async () => {
  const data = await command();
  await writeTmStream({ data });
  await writeTmStream({ data });
  expect(
    await getPrisma().notification.count({
      where: { orgId: authenticated.orgId, type: "technical-control" },
    }),
  ).toBe(1);
});
it("recovers failed notification delivery without repeating output writes", async () => {
  const data = await command();
  await env.DB.prepare(
    "CREATE TRIGGER tm_stream_notification_failure BEFORE INSERT ON notification WHEN NEW.type='technical-control' BEGIN SELECT RAISE(ABORT,'fixture notification unavailable'); END",
  ).run();
  try {
    const result = await writeTmStream({ data });
    expect(result.results.every((result) => result.success)).toBe(true);
    expect(result.notificationError).toMatch(/notification was not saved/);
  } finally {
    await env.DB.prepare("DROP TRIGGER tm_stream_notification_failure").run();
  }
  const calls = vi.mocked(fetch).mock.calls.length;
  expect((await writeTmStream({ data })).notificationError).toBeUndefined();
  expect(vi.mocked(fetch).mock.calls).toHaveLength(calls);
  expect(
    await getPrisma().notification.count({
      where: { orgId: authenticated.orgId, type: "technical-control" },
    }),
  ).toBe(1);
});
