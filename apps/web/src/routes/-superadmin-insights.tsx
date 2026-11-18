import { useState } from "react";
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
  const selectOrg = (value: string, change: (id: string) => void) => <select aria-label="Organization" value={value} onChange={e => change(e.target.value)}><option value="">Select organization</option>{orgs.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}</select>;
  return <div className="space-y-6">
    {error && <p role="alert">{error}</p>}
    <section className="rounded-xl border border-board-border bg-board-card p-4 space-y-3">
      <h2 className="font-semibold">Org 360</h2>
      {selectOrg(orgId, id => { setOrgId(id); setOrg(undefined); })}
      <button disabled={busy || !orgId} onClick={() => run(async () => setOrg(await getOrg360({ data: { orgId } })))}>Load organization</button>
      {org && <>{Object.entries(org).map(([label, value]) => <div key={label}><h3 className="font-semibold capitalize">{label}</h3><Records value={value} /></div>)}</>}
    </section>
    <section className="rounded-xl border border-board-border bg-board-card p-4 space-y-3">
      <h2 className="font-semibold">Searchable audit log</h2>
      <p>Coverage: bridge credentials, scoped tokens, and permission grants and revokes.</p>
      <form className="flex flex-wrap gap-3" onSubmit={e => { e.preventDefault(); void loadAudit(0); }}>
        {selectOrg(filters.orgId, id => setFilters({ ...filters, orgId: id }))}
        <select aria-label="Source" value={filters.source} onChange={e => setFilters({ ...filters, source: e.target.value })}><option value="">All sources</option>{["bridge-credential", "scoped-token", "permission"].map(s => <option key={s}>{s}</option>)}</select>
        {(["actorUserId", "search", "from", "to"] as const).map(key => <label key={key}>{key}<input type={key === "from" || key === "to" ? "datetime-local" : "text"} value={filters[key]} onChange={e => setFilters({ ...filters, [key]: e.target.value })} /></label>)}
        <button disabled={busy}>Search</button>
      </form>
      {audit && <><p>{audit.total} events · Page {page + 1}</p><Records value={audit.events} /><button disabled={busy || page === 0} onClick={() => loadAudit(page - 1)}>Previous</button><button disabled={busy || (page + 1) * 50 >= audit.total} onClick={() => loadAudit(page + 1)}>Next</button></>}
    </section>
    <section className="rounded-xl border border-board-border bg-board-card p-4 space-y-3">
      <h2 className="font-semibold">Feature usage derived from product data</h2>
      <label>Window<select defaultValue="30" onChange={e => { const days = Number(e.target.value) as 7 | 30 | 90; void run(async () => setUsage(await getFeatureUsage({ data: { days } }))); }}>{[7,30,90].map(days => <option key={days} value={days}>{days} days</option>)}</select></label>
      <button disabled={busy} onClick={() => run(async () => setUsage(await getFeatureUsage({ data: { days: 30 } })))}>Load 30 days</button>
      {usage && <><h3>Platform summary</h3><Records value={usage.summary} /><h3>Per organization</h3><Records value={usage.orgs} /></>}
    </section>
  </div>;
}
function Records({ value }: { value: unknown }) {
  if (Array.isArray(value)) return value.length ? <div className="overflow-auto"><table className="w-full text-sm"><tbody>{value.map((row, i) => <tr key={i} className="border-b border-board-border">{Object.entries(row).map(([key, cell]) => <td key={key} className="p-2 align-top"><span className="text-board-muted">{key}: </span><Records value={cell} /></td>)}</tr>)}</tbody></table></div> : <p>No records</p>;
  if (value instanceof Date) return <span>{value.toLocaleString()}</span>;
  if (value && typeof value === "object") return <dl>{Object.entries(value).map(([key, cell]) => <div key={key}><dt className="inline text-board-muted">{key}: </dt><dd className="inline"><Records value={cell} /></dd></div>)}</dl>;
  return <span>{value === null || value === undefined ? "None" : String(value)}</span>;
}
