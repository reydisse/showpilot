import { useEffect, useState } from "react";
import { ArrowRight, Plus, QrCode } from "lucide-react";
import { workspaceCopy } from "@showpilot/shared";
import { useTerms as useWorkspaceTerms } from "@/components/workspace/WorkspaceProvider";
import { ASSIGNABLE_ROLES, ROLE_META } from "@/lib/permissions";
import { validateSetupTeam, type SetupCrewRow, type SetupInviteRow } from "@/lib/setup-team";
import { DEPARTMENTS, getDepartment } from "@/types/index";
import { setupAttemptIsActive } from "@/lib/setup-save-contract";
import { useSetupTeamSave } from "@/hooks/useSetupTeamSave";
import { useConfirmDialog } from "@/components/ui/confirm-dialog";
const T = { stage: "#0A0B0D", panel: "#13151A", border: "#262A32", text: "#E9EBEE", muted: "#8B919C", amber: "#FFB224" };
const actionClass = "min-h-11 rounded-lg border border-white/20 px-4 py-2 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-amber-400 disabled:opacity-50";
export function SetupTeam({ orgId, onFinished, onStateChange }: { orgId: string; onFinished: () => void; onStateChange?: (state: { busy: boolean; saved: boolean }) => void }) {
  const save = useSetupTeamSave(orgId, onFinished);
  const saved = Boolean(save.snapshot?.batch);
  useEffect(() => { onStateChange?.({ busy: save.busy, saved }); }, [save.busy, saved, onStateChange]);
  const { confirm, ConfirmDialogEl } = useConfirmDialog();
  const batch = save.snapshot?.batch;
  const unresolved = save.snapshot?.invitations.filter(job => job?.state !== "accepted").length ?? 0;
  return <div className="space-y-4" aria-busy={save.busy}>
    {ConfirmDialogEl}
    {save.failure && <div role="alert" className="rounded-xl border border-red-400/40 p-4 text-sm text-red-200">
      <p>{save.failure.message}</p><p className="mt-2">Last attempt: {new Date(save.failure.occurredAt).toLocaleTimeString()}</p>
    </div>}
    {save.busy && <p role="status" className="flex items-center gap-2 text-sm"><span aria-hidden="true" className="size-4 animate-spin rounded-full border-2 border-current border-t-transparent" />Confirming setup…</p>}
    {!save.snapshot && !save.busy && !save.failure && <p role="status">Loading saved setup…</p>}
    {(!save.snapshot || save.failure || batch) && <button type="button" className={actionClass} disabled={save.busy} onClick={() => void save.check()}>Check saved results</button>}
    {save.snapshot && !batch && <>
      <SetupTeamForm taking={save.busy} locked={save.frozen} onGoLive={team => save.save(team)} />
      {save.frozen && !save.busy && <button type="button" className={actionClass} onClick={() => void save.save()}>Retry saving team</button>}
    </>}
    {batch && <section className="space-y-5">
      <h1 className="pt-8 text-3xl font-bold">Review your saved team</h1>
      <p className="text-sm text-slate-300">{batch.crew.length} crew {batch.crew.length === 1 ? "member was" : "members were"} saved. Checking or retrying invitations will not add them again. Later roster changes can be made in Team.</p>
      {batch.crew.length > 0 && <ul className="space-y-2">{batch.crew.map(row => <li key={row.id} className="rounded-lg border border-white/15 p-3">{row.name} · {row.pos}</li>)}</ul>}
      {batch.invites.map((row, index) => {
        const job = save.snapshot?.invitations[index];
        const label = !job ? "Not sent yet." : job.state === "accepted" ? "Invitation created. Email accepted for delivery."
          : job.state === "failed" ? "Invitation created. Email delivery failed."
          : job.state === "running" && setupAttemptIsActive(job) ? "Waiting for invitation confirmation."
          : "Invitation or email delivery is not confirmed.";
        return <div key={row.email} className="space-y-2 break-words rounded-xl border border-white/20 p-4">
          <p className="font-semibold">{row.email}</p><p className="text-sm text-slate-300">{ROLE_META[row.role].label}</p>
          <p role="status" className="text-sm">{label}</p>
          {job && <p className="text-xs text-slate-400">Last attempt: {new Date(job.occurredAt).toLocaleTimeString()}</p>}
          {job?.state !== "accepted" && <>
            {job && <p className="text-sm text-slate-300">Check saved results first. Resending may send another email if the earlier delivery succeeded. Expired, revoked or mismatched invitations need review in Team.</p>}
            <button type="button" aria-label={`${job ? "Resend" : "Send"} invitation to ${row.email}`} disabled={save.busy || Boolean(job && setupAttemptIsActive(job))} className={actionClass}
              onClick={() => void save.send(index)}>{job ? "Resend invitation" : "Send invitation"}</button>
          </>}
        </div>;
      })}
      <p className="text-sm text-slate-300">Finishing setup opens your workspace. It does not start a show or turn on outputs.</p>
      {unresolved === 0 ? <button type="button" className={actionClass} disabled={save.busy} onClick={() => void save.finish()}>Finish setup</button>
        : <button type="button" className={actionClass} disabled={save.busy} onClick={async () => {
          const accepted = await confirm({ title: "Continue with unresolved invitations?", description: "Your saved crew will stay. Some invitations have not been confirmed, and pending requests may still finish. Review or resend them from Team after setup.", confirmLabel: "Continue to workspace", variant: "warning" });
          if (accepted) void save.finish(true);
        }}>Continue without remaining invitations</button>}
    </section>}
  </div>;
}

const inputStyle = {
  background: T.stage,
  borderColor: T.border,
  color: T.text,
} as const;

export function SetupTeamForm({
  onGoLive, taking, locked = false,
}: {
  taking: boolean;
  locked?: boolean;
  onGoLive: (team: { crew: SetupCrewRow[]; invites: SetupInviteRow[] }) => Promise<void>;
}) {
  const workspaceTerms = useWorkspaceTerms();
  const [crew, setCrew] = useState<SetupCrewRow[]>([{ name: "", pos: "" }]);
  const [invites, setInvites] = useState<SetupInviteRow[]>([{ email: "", role: "member" }]);
  const [submitted, setSubmitted] = useState(false);
  const validation = validateSetupTeam(crew, invites);
  const issueFor = (field: string) => submitted ? validation.issues.find(issue => issue.field === field) : undefined;
  const fieldProps = (field: string) => ({
    id: field, disabled: taking || locked,
    "aria-invalid": Boolean(issueFor(field)),
    "aria-describedby": issueFor(field) ? `${field}-error` : undefined,
  });
  const fieldError = (field: string) => issueFor(field) && (
    <p id={`${field}-error`} className="mt-1 text-sm text-red-300">{issueFor(field)?.message}</p>
  );
  const inputClass = "min-h-11 w-full min-w-0 rounded-lg border px-3 py-2.5 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-amber-400 disabled:opacity-60";
  const rowActionClass = "mt-2 inline-flex min-h-11 items-center gap-1.5 rounded-lg px-3 text-sm text-slate-300 focus-visible:outline focus-visible:outline-2 focus-visible:outline-amber-400 disabled:opacity-60";
  const handleGoLive = () => {
    if (taking || locked) return;
    setSubmitted(true);
    if (validation.issues.length) {
      document.getElementById(validation.issues[0].field)?.focus();
      return;
    }
    void onGoLive({ crew: validation.crew, invites: validation.invites });
  };

  return (
    <form className="rise" noValidate onSubmit={event => { event.preventDefault(); handleGoLive(); }}>
      <h1 className="mb-1.5 mt-9 text-[30px] font-extrabold">Build your team.</h1>
      <p className="mb-[26px]" style={{ color: T.muted }}>
        Crew appear on your status board. Invited members can sign in. Both are optional for now.
      </p>
      {submitted && validation.invalidRows > 0 && (
        <div role="alert" className="mb-5 rounded-xl border border-red-400/40 bg-red-400/10 p-4 text-sm text-red-200">
          <p className="font-semibold">{validation.invalidRows} {validation.invalidRows === 1 ? "row needs" : "rows need"} attention.</p>
          <p>Nothing has been sent. Complete or clear the marked rows before finishing setup.</p>
        </div>
      )}
      <div className="grid min-w-0 gap-3.5 sm:grid-cols-2">
        <section aria-labelledby="setup-crew-title" className="min-w-0 rounded-[14px] border p-4 sm:p-[22px]" style={{ background: T.panel, borderColor: T.border }}>
          <h2 id="setup-crew-title" className="text-base font-bold">Add your crew</h2>
          <p className="mb-3.5 mt-1 text-[13px]" style={{ color: T.muted }}>
            People who appear on the board and check in on show day. No account or login is created.
          </p>
          {crew.map((row, i) => {
            const dept = row.pos.trim() ? getDepartment(row.pos) : null;
            const deptConfig = dept ? DEPARTMENTS[dept] : null;
            return (
              <fieldset key={i} disabled={taking || locked} className="mb-4 min-w-0 border-b pb-3" style={{ borderColor: T.border }}>
                <legend className="mb-2 text-sm font-semibold">Crew {i + 1}</legend>
                <label htmlFor={`crew-${i}-name`} className="mb-1 block text-sm">Crew {i + 1} name</label>
                <input {...fieldProps(`crew-${i}-name`)} value={row.name}
                  onChange={e => setCrew(crew.map((v, j) => j === i ? { ...v, name: e.target.value } : v))}
                  placeholder="Name" autoComplete="off" className={inputClass} style={inputStyle} />
                {fieldError(`crew-${i}-name`)}
                <label htmlFor={`crew-${i}-pos`} className="mb-1 mt-3 block text-sm">Crew {i + 1} position</label>
                <input {...fieldProps(`crew-${i}-pos`)} value={row.pos}
                  onChange={e => setCrew(crew.map((v, j) => j === i ? { ...v, pos: e.target.value } : v))}
                  placeholder="Position (e.g. Camera 2, A1)" autoComplete="off" className={inputClass} style={inputStyle} />
                {fieldError(`crew-${i}-pos`)}
                {deptConfig && <div className={`mt-2 text-xs ${deptConfig.color}`}>{deptConfig.label}</div>}
                <button type="button" className={rowActionClass} aria-label={`Clear crew row ${i + 1}`}
                  onClick={() => setCrew(crew.map((v, j) => j === i ? { name: "", pos: "" } : v))}>Clear row</button>
              </fieldset>
            );
          })}
          {crew.length < 4 && <button type="button" disabled={taking || locked} className={rowActionClass}
            onClick={() => setCrew([...crew, { name: "", pos: "" }])}><Plus size={14} /> Add another crew member</button>}
          <div className="mt-3.5 flex items-center gap-2 border-t pt-3 text-xs" style={{ borderColor: T.border, color: T.muted }}>
            <QrCode size={14} className="shrink-0" style={{ color: T.amber }} />
            {workspaceCopy('On show day, your board shows a "Scan to Serve" code. Crew check in from their phones.', workspaceTerms)}
          </div>
        </section>
        <section aria-labelledby="setup-invites-title" className="min-w-0 rounded-[14px] border p-4 sm:p-[22px]" style={{ background: T.panel, borderColor: T.border }}>
          <h2 id="setup-invites-title" className="text-base font-bold">Invite your leads</h2>
          <p className="mb-3.5 mt-1 text-[13px]" style={{ color: T.muted }}>People who log in to run rundowns, devices, and dashboards.</p>
          {invites.map((row, i) => (
            <fieldset key={i} disabled={taking || locked} className="mb-4 min-w-0 border-b pb-3" style={{ borderColor: T.border }}>
              <legend className="mb-2 text-sm font-semibold">Invitation {i + 1}</legend>
              <label htmlFor={`invite-${i}-email`} className="mb-1 block text-sm">Invitation {i + 1} email</label>
              <input {...fieldProps(`invite-${i}-email`)} value={row.email}
                onChange={e => setInvites(invites.map((v, j) => j === i ? { ...v, email: e.target.value } : v))}
                placeholder="name@example.com" type="email" autoComplete="off" className={inputClass} style={inputStyle} />
              {fieldError(`invite-${i}-email`)}
              <label htmlFor={`invite-${i}-role`} className="mb-1 mt-3 block text-sm">Invitation {i + 1} role</label>
              <select {...fieldProps(`invite-${i}-role`)} value={row.role}
                onChange={e => {
                  const role = ASSIGNABLE_ROLES.find(role => role === e.target.value);
                  if (role) setInvites(invites.map((v, j) => j === i ? { ...v, role } : v));
                }} className={inputClass} style={inputStyle}>
                {ASSIGNABLE_ROLES.map(role => <option key={role} value={role}>{ROLE_META[role].label}</option>)}
              </select>
              {fieldError(`invite-${i}-role`)}
              <p className="mt-1 text-xs" style={{ color: T.muted }}>{ROLE_META[row.role].description}</p>
              <button type="button" className={rowActionClass} aria-label={`Clear invitation row ${i + 1}`}
                onClick={() => setInvites(invites.map((v, j) => j === i ? { email: "", role: "member" } : v))}>Clear row</button>
            </fieldset>
          ))}
          {invites.length < 3 && <button type="button" disabled={taking || locked} className={rowActionClass}
            onClick={() => setInvites([...invites, { email: "", role: "member" }])}><Plus size={14} /> Add another invitation</button>}
        </section>
      </div>
      <div className="mt-8 space-y-3">
        <p role="status" className="text-sm" style={{ color: T.muted }}>
          {validation.crew.length} complete crew {validation.crew.length === 1 ? "row" : "rows"} and {validation.invites.length} complete invitation {validation.invites.length === 1 ? "row" : "rows"}.
        </p>
        <p className="text-sm" style={{ color: T.muted }}>Finish setup saves these people and opens your workspace. It does not start a show or turn on outputs.</p>
        <button type="submit" disabled={taking || locked} className="inline-flex min-h-11 items-center gap-2 rounded-xl px-5 py-3 font-semibold focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-amber-400 disabled:opacity-60"
          style={{ background: T.amber, color: T.stage }}>{taking ? "Finishing setup…" : locked ? "Team awaiting confirmation" : "Finish setup"}<ArrowRight size={17} /></button>
      </div>
    </form>
  );
}
