import { pruneOperationalErrors } from "./operational-errors.server";
import { backfillDeviceCredentials } from "./device-settings.server";
import { backfillCredentialSettings, backfillLegacyCredentialSettings } from "./credential-settings.server";
import { backfillScopedTokenDigests } from "./scoped-token-store.server";
import { backfillLegacyBridgeInstallations } from "./bridge-credentials.server";
import { withDatabaseTask } from "./request-database.server";
export interface CronEnv { DB: D1Database; CRON_JOBS: Queue<CronMessage>; EXPO_ACCESS_TOKEN?: string; CREDENTIAL_ENCRYPTION_KEYS?: string; }
export const CRON_JOBS = ["prune-operational-errors", "check-expo-push-receipts", "create-due-post-show-reminders", "create-due-duty-reminders", "backfill-scoped-token-digests", "backfill-credential-settings", "backfill-device-credentials", "backfill-legacy-bridge-installations"] as const;
export type CronMessage = { job: typeof CRON_JOBS[number] };

export async function runCronJob(job: CronMessage["job"], e: CronEnv): Promise<void> {
  switch (job) {
    case "prune-operational-errors": await pruneOperationalErrors(e.DB); return;
    case "check-expo-push-receipts": await (await import("./expo-push-receipts.server")).checkExpoPushReceipts(e.DB, { accessToken: e.EXPO_ACCESS_TOKEN }); return;
    case "create-due-post-show-reminders": await (await import("./show-report-notes")).createDuePostShowReminders(e.DB); return;
    case "create-due-duty-reminders": await (await import("./duty-roster.server")).createDueDutyReminders(e.DB); return;
    case "backfill-scoped-token-digests": await backfillScopedTokenDigests(e.DB); return;
    case "backfill-credential-settings":
      await backfillCredentialSettings(e.DB, e.CREDENTIAL_ENCRYPTION_KEYS);
      await backfillLegacyCredentialSettings(e.DB, e.CREDENTIAL_ENCRYPTION_KEYS);
      return;
    case "backfill-device-credentials": await backfillDeviceCredentials(e.DB, e.CREDENTIAL_ENCRYPTION_KEYS).then(result => { if (result.invalid) throw new Error(`Device credential migration found ${result.invalid} invalid settings rows.`); }); return;
    case "backfill-legacy-bridge-installations": await backfillLegacyBridgeInstallations(e.DB).then(result => { if (result.failed > 0) throw new Error(`Bridge credential migration failed for ${result.failed} installations; ${result.remaining} remain.`); }); return;
    default: throw new Error(`Unknown cron job: ${job}`);
  }
}

export async function consumeCronQueue(batch: MessageBatch<CronMessage>, env: CronEnv): Promise<void> {
    for (const message of batch.messages) {
      try {
        await withDatabaseTask(env.DB, () => runCronJob(message.body.job, env));
        message.ack();
      } catch (error) {
        // max_retries=3 means the initial delivery plus three retries.
        if (message.attempts >= 4) console.error("CRON_DLQ_ALERT", { job: message.body.job, attempts: message.attempts, error: error instanceof Error ? error.message : String(error) });
        message.retry();
      }
    }
  }
export async function enqueueCronJobs(env: CronEnv) { await env.CRON_JOBS.sendBatch(CRON_JOBS.map(job => ({ body: { job } }))); }
