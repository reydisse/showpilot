import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { seedRelayMember } from "@/test/relay-fixtures";
import { createSavedRundown } from "../saved-rundown-create.server";
import { removeSavedRundown } from "../saved-rundown-delete.server";
async function fixture() {
  const actor = { ...(await seedRelayMember(crypto.randomUUID())), pin: null };
  const id = crypto.randomUUID();
  await createSavedRundown(env.DB, actor.orgId, {
    id,
    name: "Delete fixture",
    serviceName: "Show",
    scheduledStartTime: "",
    items: [],
  });
  const rows = () =>
    env.DB.prepare(
      "SELECT key,value FROM app_setting WHERE orgId=? AND key LIKE 'rundown-%' ORDER BY key",
    )
      .bind(actor.orgId)
      .all();
  return { actor, id, rows };
}
function atCommit(
  change: () => Promise<unknown>,
): Pick<D1Database, "prepare" | "batch"> {
  return {
    prepare: (sql) => env.DB.prepare(sql),
    batch: async <T>(statements: D1PreparedStatement[]) => {
      await change();
      return env.DB.batch<T>(statements);
    },
  };
}
it.each(["membership", "session", "organization"])(
  "does not delete or fence a template when %s authority changes at commit",
  async (kind) => {
    const f = await fixture(),
      before = await f.rows();
    const db = atCommit(async () => {
      if (kind === "membership")
        return env.DB.prepare(
          "DELETE FROM member WHERE organizationId=? AND userId=?",
        )
          .bind(f.actor.orgId, f.actor.userId)
          .run();
      if (kind === "session")
        return env.DB.prepare(
          "UPDATE session SET expiresAt='2000-01-01T00:00:00Z' WHERE id=?",
        )
          .bind(f.actor.sessionId)
          .run();
      return env.DB.prepare(
        "INSERT INTO app_setting(id,orgId,key,value) VALUES(?,?,'organization-deleting','1')",
      )
        .bind(crypto.randomUUID(), f.actor.orgId)
        .run();
    });
    await expect(
      removeSavedRundown(db, f.actor.orgId, f.id, f.actor),
    ).rejects.toThrow(/access changed/);
    expect((await f.rows()).results).toEqual(before.results);
  },
);
it("does not apply a retained deletion in another organization", async () => {
  const f = await fixture(),
    other = await fixture(),
    before = await other.rows();
  await expect(
    removeSavedRundown(env.DB, other.actor.orgId, other.id, f.actor),
  ).rejects.toThrow(/authority/);
  expect((await other.rows()).results).toEqual(before.results);
});
it("checks the current rundown PIN and fences rotation before the delete commits", async () => {
  const f = await fixture();
  const pin =
    "pbkdf2-sha256:210000:MDEyMzQ1Njc4OWFiY2RlZg:dn1Cq81hnTfBlkh2maxSEZ3GzIkOQC9w2mVohTIJ_uo";
  await env.DB.prepare(
    "UPDATE member SET role='tm' WHERE organizationId=? AND userId=?",
  )
    .bind(f.actor.orgId, f.actor.userId)
    .run();
  await env.DB.prepare(
    "INSERT INTO app_setting(id,orgId,key,value) VALUES(?,?,'rundown-pin',?)",
  )
    .bind(crypto.randomUUID(), f.actor.orgId, pin)
    .run();
  await expect(
    removeSavedRundown(env.DB, f.actor.orgId, f.id, f.actor),
  ).rejects.toThrow(/PIN/);
  const db = atCommit(() =>
    env.DB.prepare(
      "UPDATE app_setting SET value='rotated' WHERE orgId=? AND key='rundown-pin'",
    )
      .bind(f.actor.orgId)
      .run(),
  );
  await expect(
    removeSavedRundown(db, f.actor.orgId, f.id, { ...f.actor, pin: "2468" }),
  ).rejects.toThrow(/access changed/);
  expect(
    (await f.rows()).results.filter((row) => row.key !== "rundown-pin"),
  ).toHaveLength(2);
}, 30000);
