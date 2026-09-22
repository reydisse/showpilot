import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { clearQueriesForIdentityTransition } from "../../../../mobile/src/lib/identity-query-cache";

describe("mobile private query identity boundary", () => {
  it("removes private data and ignores a late response from the previous account", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const key = ["mobile-bootstrap", "owner-1", "org-1"];
    client.setQueryData(key, { identity: { userId: "owner-1" }, notifications: [{ id: "private" }] });
    let release: (value: unknown) => void = () => undefined;
    const pending = client.fetchQuery({
      queryKey: ["private-delayed", "owner-1"],
      queryFn: () => new Promise((resolve) => { release = resolve; }),
    }).catch(() => undefined);

    await clearQueriesForIdentityTransition(client, "owner-1", "crew-2");
    release({ identity: { userId: "owner-1" } });
    await pending;

    expect(client.getQueryData(key)).toBeUndefined();
    expect(client.getQueryData(["private-delayed", "owner-1"])).toBeUndefined();
  });

  it("does not disturb queries when the identity is unchanged", async () => {
    const client = new QueryClient();
    client.setQueryData(["mobile-bootstrap", "owner-1", "org-1"], { ok: true });
    await clearQueriesForIdentityTransition(client, "owner-1", "owner-1");
    expect(client.getQueryData(["mobile-bootstrap", "owner-1", "org-1"])).toEqual({ ok: true });
  });
});
