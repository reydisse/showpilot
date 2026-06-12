/**
 * Standalone organization deletion — dry-run by default.
 *
 * Shares the core deletion module (src/lib/org-deletion-core.ts) with the
 * in-app deleteOrganization server function: same derived table list, same
 * ordering, same idempotency.
 *
 * Usage (from apps/web):
 *   pnpm exec tsx scripts/delete-org.ts <org-id-or-slug>            # dry run
 *   pnpm exec tsx scripts/delete-org.ts <org-id-or-slug> --execute  # delete
 *
 * Required env (D1 HTTP API):
 *   CLOUDFLARE_ACCOUNT_ID    Cloudflare account id
 *   CLOUDFLARE_DATABASE_ID   D1 database id (see wrangler.jsonc)
 *   CLOUDFLARE_D1_TOKEN      API token with D1 edit access
 * Optional:
 *   STRIPE_SECRET_KEY        required only if the org has a subscription
 *
 * Notes:
 * - --execute prompts for the exact organization name before deleting.
 * - R2 cleanup is skipped here (no R2 HTTP credentials in this script);
 *   today no org-prefixed R2 objects exist — the in-app path covers them.
 */
import { createInterface } from "node:readline/promises";
import { PrismaD1Http } from "@prisma/adapter-d1";
import { PrismaClient } from "../src/generated/prisma/client";
import {
  countOrgRows,
  deleteOrganizationCore,
  type PrismaLikeForOrgDeletion,
} from "../src/lib/org-deletion-core";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing required env var ${name}`);
    process.exit(1);
  }
  return value;
}

async function cancelStripeSubscription(subscriptionId: string): Promise<void> {
  const key = requireEnv("STRIPE_SECRET_KEY");
  const { default: Stripe } = await import("stripe");
  const stripe = new Stripe(key);
  try {
    await stripe.subscriptions.cancel(subscriptionId);
    console.log(`Cancelled Stripe subscription ${subscriptionId}`);
  } catch (err) {
    if (
      err instanceof Stripe.errors.StripeError &&
      (err.code === "resource_missing" || /canceled subscription/i.test(err.message))
    ) {
      console.log(`Stripe subscription ${subscriptionId} already cancelled — skipping`);
      return;
    }
    throw err;
  }
}

async function main() {
  const args = process.argv.slice(2);
  const execute = args.includes("--execute");
  const orgIdOrSlug = args.find((a) => !a.startsWith("--"));
  if (!orgIdOrSlug) {
    console.error("Usage: tsx scripts/delete-org.ts <org-id-or-slug> [--execute]");
    process.exit(1);
  }

  const adapter = new PrismaD1Http({
    CLOUDFLARE_ACCOUNT_ID: requireEnv("CLOUDFLARE_ACCOUNT_ID"),
    CLOUDFLARE_DATABASE_ID: requireEnv("CLOUDFLARE_DATABASE_ID"),
    CLOUDFLARE_D1_TOKEN: requireEnv("CLOUDFLARE_D1_TOKEN"),
  });
  const prisma = new PrismaClient({ adapter });

  const org =
    (await prisma.organization.findUnique({ where: { id: orgIdOrSlug } })) ??
    (await prisma.organization.findUnique({ where: { slug: orgIdOrSlug } }));
  if (!org) {
    console.error(`No organization found with id or slug "${orgIdOrSlug}"`);
    process.exit(1);
  }

  console.log(`Organization: ${org.name} (${org.id}, /${org.slug})`);
  console.log(`Plan: ${org.plan}  Stripe sub: ${org.stripeSubscriptionId ?? "none"}\n`);

  const counts = await countOrgRows(
    prisma as unknown as PrismaLikeForOrgDeletion,
    org.id,
  );
  const width = Math.max(...counts.map((c) => c.table.length));
  console.log("Rows per table:");
  for (const c of counts) {
    console.log(`  ${c.table.padEnd(width)}  ${c.rows}`);
  }
  const total = counts.reduce((sum, c) => sum + c.rows, 0);
  console.log(`  ${"TOTAL".padEnd(width)}  ${total}\n`);

  if (!execute) {
    console.log("Dry run — nothing deleted. Re-run with --execute to delete.");
    return;
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(
    `Type the organization name ("${org.name}") to permanently delete: `,
  );
  rl.close();
  if (answer.trim() !== org.name) {
    console.error("Name did not match — aborting.");
    process.exit(1);
  }

  const result = await deleteOrganizationCore({
    prisma: prisma as unknown as PrismaLikeForOrgDeletion,
    orgId: org.id,
    cancelStripeSubscription,
    deleteR2Prefix: async () => {
      console.log("R2 cleanup skipped (script has no R2 credentials)");
      return 0;
    },
  });

  console.log(
    result.alreadyDeleted
      ? "Organization was already deleted."
      : `Deleted ${result.deletedTables.length} tables' rows for ${org.name}.`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
