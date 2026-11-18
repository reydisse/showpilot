import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { expect, it, vi } from 'vitest';
import { appendWebhookEvent, normalizeWebhookEvent } from '../webhook-events';
import { getPrisma } from '../db';
const state = vi.hoisted(() => ({ scratch: false }));
vi.mock('../db', async original => {
  const actual = await original<typeof import('../db')>();
  return { getPrisma: () => state.scratch ? {
    member: { findFirst: async () => ({ role: 'owner' }) },
    $queryRaw: async (_sql: unknown, org: string, limit: number) => {
      const db = (env as unknown as {MIGRATION_DB:D1Database}).MIGRATION_DB;
      return (await db.prepare('SELECT payload FROM webhook_event WHERE orgId=? ORDER BY seq DESC LIMIT ?').bind(org,limit).all()).results;
    },
  } : actual.getPrisma() };
});
vi.mock('../auth' , () => ({ getAuth: () => ({ api: { getSession: async () => ({ user: { id: 'operator' } }) } }) }));
vi.mock('../org-access', () => ({ assertOrgPermission: async () => {}, assertOrgMember: async () => {} }));
vi.mock('@tanstack/react-start/server', () => ({ getRequestHeaders: () => new Headers() }));
vi.mock('@tanstack/react-start', () => {
  const builder = () => { const chain = { middleware: () => chain, inputValidator: () => chain, handler: (fn: Function) => fn, server: () => chain }; return chain; };
  return { createServerFn: builder, createMiddleware: builder, createServerOnlyFn: (fn: Function) => fn };
});
it('concurrent appends survive and cap retains newest 50', async () => {
  const orgId = crypto.randomUUID();
  await env.DB.prepare('INSERT INTO organization(id,name,slug,createdAt) VALUES (?,?,?,CURRENT_TIMESTAMP)').bind(orgId, orgId, orgId).run();
  const prisma = getPrisma();
  const event = { source: 'test', type: 'test', direction: 'system' as const, status: 'info' as const, details: 'test' };
  await Promise.all([appendWebhookEvent(prisma, orgId, {...event, details:'one'}), appendWebhookEvent(prisma, orgId, {...event, details:'two'})]);
  expect(await env.DB.prepare('SELECT count(*) n FROM webhook_event WHERE orgId=?').bind(orgId).first('n')).toBe(2);
  for(let i=0;i<49;i++) await appendWebhookEvent(prisma, orgId, {...event,details:`new-${i}`});
  const rows = (await env.DB.prepare('SELECT payload FROM webhook_event WHERE orgId=? ORDER BY timestamp DESC,seq DESC').bind(orgId).all<{payload:string}>()).results;
  expect(rows).toHaveLength(50);
  expect(JSON.parse(rows[0].payload).details).toBe('new-48');
  expect(rows.some(r=>JSON.parse(r.payload).details==='one')).toBe(false);
});
it('0102 migrates verbatim elements, ignores corrupt/non-array JSON and preserves other settings', async () => {
  const db = (env as unknown as {MIGRATION_DB:D1Database}).MIGRATION_DB;
  await applyD1Migrations(db, env.TEST_MIGRATIONS.filter(m=>m.name<'0102'));
  const entries = [{id:'a',timestamp:'2026-01-01',payload:{raw:true}}, {id:'b',timestamp:'2026-02-01'}, {id:'c',timestamp:'2026-02-01'}, {}];
  for (const [org,value] of [['legacy',JSON.stringify(entries)],['corrupt','{bad'],['nonarray','{}']]) {
    await db.prepare('INSERT INTO organization(id,name,slug,createdAt) VALUES (?,?,?,CURRENT_TIMESTAMP)').bind(org,org,org).run();
    await db.prepare("INSERT INTO app_setting(id,orgId,key,value) VALUES (?,?,'webhook-events',?)").bind(org,org,value).run();
  }
  await db.prepare("INSERT INTO app_setting(id,orgId,key,value) VALUES ('retained','legacy','unrelated','verbatim')").run();
  await applyD1Migrations(db,env.TEST_MIGRATIONS);
  const rows=(await db.prepare("SELECT payload FROM webhook_event WHERE orgId='legacy' ORDER BY seq DESC").all<{payload:string}>()).results;
  expect(rows.map(r=>JSON.parse(r.payload))).toEqual(entries);
  vi.spyOn(Date,'now').mockReturnValue(123);
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-03-01'));
  const pipeline=(values:unknown[])=>values.slice(0,50).map(normalizeWebhookEvent).filter(Boolean).sort((a,b)=>b!.timestamp.localeCompare(a!.timestamp));
  state.scratch = true;
  const { getRecentWebhookEvents } = await import('../settings');
  expect(JSON.stringify(await getRecentWebhookEvents({data:{orgId:'legacy'}}))).toBe(JSON.stringify(pipeline(entries)));
  expect(await getRecentWebhookEvents({data:{orgId:'corrupt'}})).toEqual([]);
  expect(await getRecentWebhookEvents({data:{orgId:'nonarray'}})).toEqual([]);
  state.scratch = false;
  vi.useRealTimers(); vi.restoreAllMocks();
  expect(await db.prepare("SELECT count(*) n FROM webhook_event WHERE orgId IN ('corrupt','nonarray')").first('n')).toBe(0);
  expect(await db.prepare("SELECT count(*) n FROM app_setting WHERE key='webhook-events'").first('n')).toBe(0);
  expect(await db.prepare("SELECT value FROM app_setting WHERE id='retained'").first('value')).toBe('verbatim');
});
