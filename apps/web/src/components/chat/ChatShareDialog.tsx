import { useEffect, useId, useRef, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { createCrewChatPass, createPlanningChatPass } from "@/lib/crew-chat-pass";
import { createBrowserId } from "@/lib/browser-id";
import { withOperationTimeout } from "@/lib/operation-timeout";
import type { ChatPassCommand, CreatedChatPass } from "@/lib/chat-pass-creation";

type Result = { status: "draft" } | { status: "saving"; command: ChatPassCommand }
  | { status: "failed"; command: ChatPassCommand; message: string; at: number }
  | { status: "ready"; command: ChatPassCommand; pass: CreatedChatPass };
type CopyState = "idle" | "copying" | "copied" | "failed";
const uncertain = "The link result is unconfirmed. Retry with the same choices to recover it.";
const control = "min-h-11 rounded-lg border border-board-border px-3 py-2 text-sm focus-visible:outline-2 disabled:opacity-50";

/** Keep mounted per workspace and room so closing preserves the exact retry. */
export function ChatShareDialog({ orgId, scope, members, open, onOpenChange, revokedToken }: {
  orgId: string;
  scope: ChatPassCommand["scope"];
  members: readonly { userId: string; name: string; role: string }[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  revokedToken: string | null;
}) {
  const [hours, setHours] = useState(8);
  const [selected, setSelected] = useState<string[]>([]);
  const [search, setSearch] = useState("");
  const [result, setResult] = useState<Result>({ status: "draft" });
  const [copy, setCopy] = useState<CopyState>("idle");
  const [validation, setValidation] = useState("");
  const operation = useRef<{ controller: AbortController; command: ChatPassCommand } | null>(null);
  const copyGeneration = useRef(0);
  const fieldId = useId();
  const planning = scope === "planning-chat";
  const editable = result.status === "draft";
  const saving = result.status === "saving";
  const pass = result.status === "ready" ? result.pass : null;
  const link = pass ? `${window.location.origin}/join/chat/${planning ? "planning/" : ""}${encodeURIComponent(pass.token)}` : "";
  // Leave headroom below level-M QR byte capacity. Large recipient lists still
  // have a fully usable text link; never let the QR encoder crash this dialog.
  const qrFits = new TextEncoder().encode(link).length <= 2000;
  const visibleMembers = members.filter(member => member.name.toLowerCase().includes(search.toLowerCase()));

  useEffect(() => () => {
    operation.current?.controller.abort();
    operation.current = null;
    copyGeneration.current++;
  }, []);
  useEffect(() => {
    if (!open) {
      const pending = operation.current;
      operation.current = null;
      pending?.controller.abort();
      if (pending) setResult({ status: "failed", command: pending.command, message: uncertain, at: Date.now() });
      copyGeneration.current++;
      setCopy("idle");
    }
  }, [open]);
  useEffect(() => {
    if (result.status !== "ready") return;
    const current = result;
    const revoked = revokedToken !== null && revokedToken.split(".").slice(0, 2).join(".") === current.pass.token.split(".").slice(0, 2).join(".");
    const invalidate = (message: string) => {
      copyGeneration.current++;
      setCopy("idle");
      setResult({ status: "failed", command: current.command, message, at: Date.now() });
    };
    if (revoked) { invalidate("This link was disabled. Start a new link when you need access again."); return; }
    const remaining = current.pass.expiresAt - Date.now();
    const expired = () => invalidate("This link has expired. Start a new link.");
    if (remaining <= 0) { expired(); return; }
    const timer = setTimeout(expired, remaining);
    return () => clearTimeout(timer);
  }, [result, revokedToken]);

  const create = async (command: ChatPassCommand) => {
    if (operation.current) return;
    const pending = { controller: new AbortController(), command };
    operation.current = pending;
    copyGeneration.current++;
    setCopy("idle");
    setResult({ status: "saving", command });
    try {
      const options = { data: command, signal: pending.controller.signal };
      const response = command.scope === "crew-chat" ? createCrewChatPass(options)
        : createPlanningChatPass({ data: command, signal: pending.controller.signal });
      const saved = await withOperationTimeout(response, 10_000, uncertain);
      if (operation.current === pending) setResult({ status: "ready", command, pass: saved });
    } catch (error) {
      if (operation.current === pending) setResult({ status: "failed", command, message: error instanceof Error ? error.message : uncertain, at: Date.now() });
    } finally {
      pending.controller.abort();
      if (operation.current === pending) operation.current = null;
    }
  };
  const start = () => {
    if (planning && (!selected.length || selected.length > 50)) { setValidation("Choose between 1 and 50 members."); return; }
    if (planning && selected.some(id => !members.some(member => member.userId === id))) { setValidation("A selected member is no longer available. Review your selection before creating a link."); return; }
    const common = { orgId, hours, requestId: createBrowserId() };
    void create(planning ? { ...common, scope: "planning-chat", targetUserIds: [...selected] } : { ...common, scope: "crew-chat" });
  };
  const copyLink = async () => {
    if (!pass || pass.expiresAt <= Date.now() || copy === "copying") return;
    const id = ++copyGeneration.current;
    setCopy("copying");
    try {
      await withOperationTimeout(navigator.clipboard.writeText(link), 5_000, "Copy timed out");
      if (id === copyGeneration.current) setCopy("copied");
    } catch { if (id === copyGeneration.current) setCopy("failed"); }
  };

  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent aria-modal="true" showCloseButton={false} className="max-h-[calc(100dvh-2rem)] overflow-y-auto border-board-border bg-board-card text-board-text sm:max-w-xl">
      <DialogHeader>
        <DialogTitle>{planning ? "Share Planning Room" : "Invite guest crew"}</DialogTitle>
        <DialogDescription>{planning ? "Choose up to 50 members. They must sign in to use this link. Selected members also receive an inbox notification." : "Guests enter their name to join Production Chat."}</DialogDescription>
      </DialogHeader>
      {!pass && <>
        {planning && <fieldset disabled={!editable} className="min-w-0 space-y-2">
          <legend className="mb-2 text-sm font-medium">Members · {selected.length} selected</legend>
          <label htmlFor={`${fieldId}-search`} className="block text-sm">Search members</label>
          <input id={`${fieldId}-search`} value={search} onChange={event => setSearch(event.target.value)} className={`${control} w-full bg-board-bg`} />
          <div className="max-h-44 overflow-y-auto rounded-lg border border-board-border">
            {visibleMembers.map(member => <label key={member.userId} className="flex min-h-11 cursor-pointer items-center gap-3 px-3 py-2 text-sm">
              <input type="checkbox" checked={selected.includes(member.userId)} onChange={event => {
                setSelected(current => event.target.checked ? [...current, member.userId] : current.filter(id => id !== member.userId));
                setValidation("");
              }} />
              <span className="min-w-0 [overflow-wrap:anywhere]">{member.name}{" "}<span className="ml-2 text-xs text-board-muted">{member.role}</span></span>
            </label>)}
            {!visibleMembers.length && <p className="p-3 text-sm text-board-muted">No members match this search.</p>}
          </div>
        </fieldset>}
        <fieldset disabled={!editable}>
          <legend className="mb-2 text-sm font-medium">Link duration</legend>
          <div className="grid grid-cols-3 gap-2">{[2, 8, 24].map(value => <label key={value} className={`${control} flex cursor-pointer items-center justify-center gap-2 ${hours === value ? "border-fire-500/50 bg-fire-500/10" : ""}`}>
            <input type="radio" name={`${fieldId}-hours`} checked={hours === value} onChange={() => setHours(value)} />{value}h
          </label>)}</div>
        </fieldset>
      </>}
      {validation && <p role="alert" className="text-sm text-red-300">{validation}</p>}
      {result.status === "failed" && <div role="alert" className="space-y-1 text-sm text-red-300"><p>{result.message}</p><p className="text-xs">Last attempt: {new Date(result.at).toLocaleTimeString()}</p></div>}
      {saving && <p role="status" className="text-sm">Confirming link and notifications…</p>}
      {pass && <>
        <p role="status" className="font-medium">{planning ? "Planning link is ready" : "Crew pass is ready"}</p>
        {qrFits ? <div className="mx-auto rounded-xl bg-white p-3"><QRCodeSVG role="img" aria-label="Chat join QR code" value={link} size={190} level="M" /></div>
          : <p className="text-sm text-board-muted">This link is too long for a QR code. Copy the link to share it.</p>}
        <label htmlFor={`${fieldId}-link`} className="text-sm font-medium">{planning ? "Planning invite link" : "Crew join link"}</label>
        <textarea id={`${fieldId}-link`} readOnly value={link} rows={3} onFocus={event => event.currentTarget.select()} className="min-w-0 w-full resize-y rounded-lg border border-board-border bg-board-bg p-3 text-xs [overflow-wrap:anywhere]" />
        <button type="button" disabled={copy === "copying"} onClick={() => void copyLink()} className={control}>{copy === "copying" ? "Copying…" : copy === "copied" ? "Copied" : copy === "failed" ? "Retry copy" : "Copy link"}</button>
        {copy === "failed" && <p role="alert" className="text-sm text-red-300">Could not copy. Select the link above and copy it manually, or retry.</p>}
        <p className="text-xs text-board-muted">Expires {new Date(pass.expiresAt).toLocaleString()}{planning ? ` · ${pass.targetCount} selected members` : ""}</p>
        {pass.notifications.status === "saved" && <p className="text-sm">Inbox notifications saved for {pass.notifications.recipients} members. Device push delivery is not confirmed.</p>}
        {pass.notifications.status === "pending" && <div role="alert" className="space-y-2 text-sm text-amber-300">
          <p>The link is ready, but {pass.notifications.missing} inbox notification(s) could not be confirmed.</p>
          {result.status === "ready" && <button type="button" onClick={() => void create(result.command)} className={control}>Retry notifications</button>}
        </div>}
      </>}
      {result.status !== "draft" && !saving && <p className="text-xs text-board-muted">Retry keeps this request and its original expiry. Starting a new link leaves any earlier link active until it expires or you disable it.</p>}
      <div className="flex flex-wrap justify-end gap-2">
        <button type="button" onClick={() => onOpenChange(false)} className={control}>Close</button>
        {result.status !== "draft" && !saving && <button type="button" className={control} onClick={() => {
          copyGeneration.current++; setCopy("idle"); setResult({ status: "draft" }); setValidation("");
        }}>Start a new link</button>}
        {result.status === "failed" && <button type="button" onClick={() => void create(result.command)} className={`${control} bg-fire-500 text-black`}>Retry link</button>}
        {editable && <button type="button" onClick={start} className={`${control} bg-fire-500 text-black`}>{planning ? "Create Planning link" : "Create crew pass"}</button>}
      </div>
    </DialogContent>
  </Dialog>;
}
