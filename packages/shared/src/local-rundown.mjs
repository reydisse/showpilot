import { applyRundownTransport, parseRundownTransport } from './rundown-transport.mjs';

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const id = value => typeof value === 'string' && value.length > 0 && value.length <= 200;
const timestamp = value => Number.isSafeInteger(value) && value >= 0;

/** Validate a bounded local transport journal. Device execution is deliberately
 * absent: reconnect may reconcile progress but must never replay physical output.
 */
export function parseLocalRundownJournal(value, now) {
  if (!record(value) || value.version !== 1 || !id(value.sessionId) || value.sessionId.length > 100
    || !id(value.orgId) || !id(value.showId) || typeof value.serviceDate !== 'string'
    || !/^\d{4}-\d{2}-\d{2}$/.test(value.serviceDate)
    || !Number.isSafeInteger(value.baseRevision) || value.baseRevision < 0
    || !timestamp(value.startedAt) || !timestamp(value.endedAt)
    || value.endedAt < value.startedAt || value.endedAt > now + 5000
    || value.endedAt - value.startedAt > 86_400_000
    || !Array.isArray(value.operations) || value.operations.length > 2000) return null;
  let previous = value.startedAt;
  const operations = [];
  for (const operation of value.operations) {
    if (!record(operation) || !timestamp(operation.at) || operation.at < previous || operation.at > value.endedAt) return null;
    const command = parseRundownTransport(operation.action, operation.payload);
    if (!command) return null;
    previous = operation.at;
    operations.push({at:operation.at,command});
  }
  return {version:1,sessionId:value.sessionId,orgId:value.orgId,showId:value.showId,serviceDate:value.serviceDate,
    baseRevision:value.baseRevision,startedAt:value.startedAt,endedAt:value.endedAt,operations};
}

/** Replay timing transitions against the exact cloud base revision. No device
 * dispatcher is accepted by this function. Hold the reconciled clock for review.
 */
export function reconcileLocalRundown(state, target, journal) {
  if (journal.orgId !== target.orgId || journal.showId !== target.showId || journal.serviceDate !== target.serviceDate) return {ok:false,reason:'wrong-show'};
  if (journal.baseRevision !== target.revision) return {ok:false,reason:'revision-conflict'};
  let next = state;
  for (const operation of journal.operations) {
    next = applyRundownTransport(next, operation.command, operation.at);
    if (!next) return {ok:false,reason:'invalid-command'};
  }
  const held = applyRundownTransport(next, {type:'timer-pause'}, journal.endedAt);
  return {ok:true,state:held,sessionId:journal.sessionId};
}
