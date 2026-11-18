import { type ReactNode, useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";
import { ROLE_META } from "@/lib/permissions";
import { getOrg360, getAuditLog, getFeatureUsage } from "@/lib/superadmin";

export function SuperAdminInsights({ orgs }: { orgs: { id: string; name: string }[] }) {
  const [orgId, setOrgId] = useState("");
  const [org, setOrg] = useState<Awaited<ReturnType<typeof getOrg360>>>();
  const [audit, setAudit] = useState<Awaited<ReturnType<typeof getAuditLog>>>();
  const [usage, setUsage] = useState<Awaited<ReturnType<typeof getFeatureUsage>>>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [page, setPage] = useState(0);
  const [filters, setFilters] = useState({ orgId: "", actorUserId: "", source: "", search: "", from: "", to: "" });
  async function run(task: () => Promise<void>) { setBusy(true); setError(""); try { await task(); } catch { setError("Unable to load insights. Please retry."); } finally { setBusy(false); } }
  async function loadAudit(next: number) {
    await run(async () => {
      setAudit(await getAuditLog({ data: { orgId: filters.orgId || undefined, actorUserId: filters.actorUserId || undefined,
        source: (filters.source || undefined) as "bridge-credential" | "scoped-token" | "permission" | undefined,
        search: filters.search || undefined, from: filters.from ? new Date(filters.from).getTime() : undefined,
        to: filters.to ? new Date(filters.to).getTime() : undefined, page: next } })); setPage(next);
    });
  }
  const control = "h-9 rounded-md border border-board-border bg-board-bg px-3 text-sm text-board-text";
  const selectOrg = (value: string, change: (id: string) => void) => <select className={control} aria-label="Organization" value={value} onChange={e => change(e.target.value)}><option value="">Select organization</option>{orgs.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}</select>;
  return <div className="space-y-6 text-board-text" aria-busy={busy}>
    {error && <p role="alert" className="text-sm text-red-500">{error}</p>}
    {busy && <p role="status" className="text-sm text-board-muted">Loading insights…</p>}
    <section className="rounded-xl border border-board-border bg-board-card p-4 space-y-4">
      <h2 className="font-semibold">Org 360</h2>
      <div className="flex flex-wrap gap-3">{selectOrg(orgId, id => { setOrgId(id); setOrg(undefined); })}<Button disabled={busy || !orgId} onClick={() => run(async () => setOrg(await getOrg360({ data: { orgId } })))}>Load organization</Button></div>
      {!org ? <Empty>Select an organization to view its details.</Empty> : <>
        <header className="space-y-2"><h3 className="text-xl font-semibold">{org.profile.name}</h3><p className="text-sm text-board-muted">{org.profile.slug} · Created {date(org.profile.createdAt)}</p><div className="flex flex-wrap gap-2"><Badge variant="secondary">{human(org.billing.effectivePlan)}</Badge><Status value={org.billing.subscriptionStatus} />{org.billing.foundingMember && <Badge variant="outline">Founding member</Badge>}{org.billing.betaTester && <Badge variant="outline">Beta tester</Badge>}</div></header>
        <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">{[
          ["Plan", human(org.billing.plan)], ["Trial ends", date(org.billing.trialEndsAt)], ["Subscription status", <Status value={org.billing.subscriptionStatus} />], ["Stripe customer", yes(org.billing.hasStripeCustomer)], ["Stripe subscription", yes(org.billing.hasStripeSubscription)], ["Cloud enabled", yes(org.profile.cloud_enabled)],
        ].map(([label, value], i) => <div key={i}><dt className="text-xs text-board-muted">{label}</dt><dd className="mt-1 text-sm">{value}</dd></div>)}</dl>
        <DataTable title="Members" headers={["Name", "Email", "Role"]} rows={org.members.map(m => [m.user.name || "—", m.user.email, <Badge variant="secondary">{ROLE_META[m.role as keyof typeof ROLE_META]?.label ?? human(m.role)}</Badge>])} empty="No members yet" />
        <DataTable title={`Shows (${org.showCount})`} headers={["Name", "Service date", "Status"]} rows={org.shows.map(s => [s.name, date(s.serviceDate), <Status value={s.status} />])} empty="No shows yet" />
        <DataTable title="Devices" headers={["Name", "Category", "Enabled"]} rows={org.devices.map(d => [d.name, human(d.category), yes(d.enabled)])} empty="No devices yet" />
        <DataTable title="Bridges" headers={["Label", "Installed", "Last used", "Status"]} rows={org.bridges.map(b => [b.label || "Unnamed bridge", date(b.createdAt), date(b.lastUsedAt), b.revokedAt === null ? "Active" : <span className="text-board-muted">Revoked {date(b.revokedAt)}</span>])} empty="No bridges installed" />
        <h3 className="font-medium">Recent activity</h3>{org.activity.length ? <ul className="divide-y divide-board-border text-sm text-board-muted">{org.activity.map(e => <li key={e.id} className="flex flex-wrap gap-x-3 gap-y-1 py-2"><span>{date(e.createdAtMs, true)}</span><span>{e.actorLabel}</span><span>{human(e.action)}</span></li>)}</ul> : <Empty>No recent activity</Empty>}
      </>}
    </section>
    <section className="rounded-xl border border-board-border bg-board-card p-4 space-y-4">
      <h2 className="font-semibold">Searchable audit log</h2>
      <p className="rounded-lg border border-board-border bg-board-bg p-3 text-xs text-board-muted">The log covers bridge credentials, scoped tokens, and permission grants and revokes. Role changes, plan changes, and data exports are not recorded.</p>
      <form className="flex flex-wrap items-end gap-3" onSubmit={e => { e.preventDefault(); void loadAudit(0); }}>
        <label className="grid gap-1 text-xs text-board-muted">Organization{selectOrg(filters.orgId, id => setFilters({ ...filters, orgId: id }))}</label>
        <label className="grid gap-1 text-xs text-board-muted">Source<select className={control} value={filters.source} onChange={e => setFilters({ ...filters, source: e.target.value })}><option value="">All sources</option><option value="bridge-credential">Bridge credentials</option><option value="scoped-token">Scoped tokens</option><option value="permission">Permissions</option></select></label>
        {([['actorUserId', 'Actor'], ['search', 'Search'], ['from', 'From'], ['to', 'To']] as const).map(([key, label]) => <label className="grid gap-1 text-xs text-board-muted" key={key}>{label}<Input className="border-board-border bg-board-bg text-board-text" type={key === "from" || key === "to" ? "datetime-local" : "text"} value={filters[key]} onChange={e => setFilters({ ...filters, [key]: e.target.value })} /></label>)}
        <Button disabled={busy}>Search</Button>
      </form>
      {audit ? <><DataTable headers={["Time", "Actor", "Event", "Organization", "Source", "Target"]} rows={audit.events.map(e => [date(e.createdAtMs, true), e.actorLabel, human(e.action), e.orgName || "—", <Badge variant="secondary">{human(e.source)}</Badge>, <span className="text-board-muted break-all whitespace-normal">{e.target || "—"}</span>])} empty="No events match these filters" /><div className="flex flex-wrap items-center gap-3"><p className="mr-auto text-sm text-board-muted">{audit.total} events · Page {page + 1} of {Math.max(1, Math.ceil(audit.total / 50))}</p><Button variant="outline" disabled={busy || page === 0} onClick={() => loadAudit(page - 1)}>Previous</Button><Button variant="outline" disabled={busy || (page + 1) * 50 >= audit.total} onClick={() => loadAudit(page + 1)}>Next</Button></div></> : <Empty>Search to view audit events.</Empty>}
    </section>
    <section className="rounded-xl border border-board-border bg-board-card p-4 space-y-4">
      <header><h2 className="font-semibold">Feature usage</h2><p className="text-sm text-board-muted">Derived from product data.</p></header>
      <div role="group" aria-label="Usage window" className="inline-flex rounded-lg border border-board-border bg-board-bg p-1 gap-1">{([7,30,90] as const).map(days => <Button key={days} size="sm" variant={usage?.days === days ? "secondary" : "ghost"} aria-pressed={usage?.days === days} disabled={busy} onClick={() => run(async () => setUsage(await getFeatureUsage({ data: { days } })))}>{days} days</Button>)}</div>
      {usage ? <><DataTable title="Platform summary" headers={["Feature", "Total", "Active orgs"]} numeric rows={usage.summary.map(s => [s.feature, s.total.toLocaleString(), s.activeOrgs.toLocaleString()])} empty="No feature usage in this window" /><DataTable title="Per organization" headers={["Organization", ...usage.summary.map(s => s.feature)]} numeric rows={usage.orgs.map(o => [o.name, ...usage.summary.map(s => o.counts[s.feature] ? o.counts[s.feature].toLocaleString() : <span className="text-board-muted">0</span>)])} empty="No organizations yet" /></> : <Empty>Select a window to view feature usage.</Empty>}
    </section>
  </div>;
}

function human(value: string | null | undefined) { return value ? value.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim().replace(/^./, c => c.toUpperCase()) : "—"; }
function yes(value: boolean) { return value ? "Yes" : "No"; }
function date(value: Date | string | number | null | undefined, time = false) {
  if (value == null) return "—";
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isNaN(parsed.getTime()) ? "—" : parsed.toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", ...(time ? { hour: "numeric", minute: "2-digit" } as const : {}) });
}
function Empty({ children }: { children: ReactNode }) { return <p className="rounded-lg border border-dashed border-board-border p-4 text-sm text-board-muted">{children}</p>; }
function Status({ value }: { value: string | null }) {
  const tone = value === "active" ? "bg-green-500/10 text-green-600 dark:text-green-400" : value === "past_due" ? "bg-amber-500/10 text-amber-700 dark:text-amber-400" : value === "trialing" ? "bg-blue-500/10 text-blue-600 dark:text-blue-400" : "text-board-muted";
  return <Badge variant="secondary" className={tone}>{human(value)}</Badge>;
}
function DataTable({ title, headers, rows, empty, numeric = false }: { title?: string; headers: string[]; rows: ReactNode[][]; empty: string; numeric?: boolean }) {
  return <div className="space-y-2">{title && <h3 className="font-medium">{title}</h3>}{rows.length ? <Table aria-label={title}><TableHeader><TableRow className="border-board-border">{headers.map((h, i) => <TableHead key={h} className={numeric && i > 0 ? "text-right text-board-muted" : "text-board-muted"}>{h}</TableHead>)}</TableRow></TableHeader><TableBody>{rows.map((cells, i) => <TableRow key={i} className="border-board-border">{cells.map((cell, j) => <TableCell key={j} className={numeric && j > 0 ? "text-right tabular-nums" : ""}>{cell}</TableCell>)}</TableRow>)}</TableBody></Table> : <Empty>{empty}</Empty>}</div>;
}
