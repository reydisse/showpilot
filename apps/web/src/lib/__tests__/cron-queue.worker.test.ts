import { env } from 'cloudflare:workers';
import { afterEach, expect, it, vi } from 'vitest';
import { enqueueCronJobs, consumeCronQueue, CRON_JOBS } from '../cron-queue.server';
const worker = { scheduled: (_c: ScheduledController, e: Parameters<typeof enqueueCronJobs>[0]) => enqueueCronJobs(e), queue: consumeCronQueue };
import * as errors from '../operational-errors.server';
vi.mock('@tanstack/react-start/server-entry', () => ({ default: { fetch: vi.fn() } }));
afterEach(() => vi.restoreAllMocks());
function bindings() { return { ...env, CRON_JOBS: { sendBatch: vi.fn().mockResolvedValue(undefined) } } as unknown as Parameters<typeof worker.scheduled>[1]; }
it('Producer: scheduled enqueues every job without running jobs inline', async () => {
 const prune = vi.spyOn(errors, 'pruneOperationalErrors');
 const e = bindings();
 await worker.scheduled({} as ScheduledController, e);
 expect(e.CRON_JOBS.sendBatch).toHaveBeenCalledExactlyOnceWith(CRON_JOBS.map(job => ({body: {job}})));
 expect(prune).not.toHaveBeenCalled();
});
it('Consumer: named job invokes exactly that function with its database', async () => {
 const prune = vi.spyOn(errors, 'pruneOperationalErrors').mockResolvedValue(undefined);
 const e = bindings(); const ack = vi.fn(); const retry = vi.fn();
 await worker.queue({messages: [{body:{job:'prune-operational-errors'}, attempts:1, ack, retry}]} as unknown as MessageBatch<import('../cron-queue.server').CronMessage>, e);
 expect(prune).toHaveBeenCalledOnce(); expect(prune.mock.calls[0][0] === e.DB).toBe(true); expect(ack).toHaveBeenCalledOnce(); expect(retry).not.toHaveBeenCalled();
});
it('Retry/DLQ: failures retry and final delivery alerts exactly once', async () => {
 vi.spyOn(errors, 'pruneOperationalErrors').mockRejectedValue(new Error('broken'));
 const log = vi.spyOn(console, 'error').mockImplementation(() => {}); const retry = vi.fn(); const ack = vi.fn();
 for (const attempts of [1,2,3,4]) await worker.queue({messages:[{body:{job:'prune-operational-errors'}, attempts, ack, retry}]} as unknown as MessageBatch<import('../cron-queue.server').CronMessage>, bindings());
 expect(retry).toHaveBeenCalledTimes(4); expect(ack).not.toHaveBeenCalled(); expect(log).toHaveBeenCalledExactlyOnceWith('CRON_DLQ_ALERT', {job:'prune-operational-errors', attempts:4, error:'broken'});
});
