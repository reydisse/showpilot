import { useEffect, useId, useRef, useState } from "react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useConfirmDialog } from "@/components/ui/confirm-dialog";
import { revokeChatPass } from "@/lib/crew-chat-pass";
import { withOperationTimeout } from "@/lib/operation-timeout";

type Result = { status: "idle" | "saving" } | { status: "failed"; message: string; at: number }
  | { status: "revoked"; disconnected: boolean } | { status: "expired" };

export function chatTokenFromLink(value: string): string {
  const text = value.trim();
  if (/^(chat_|planning_chat_)/.test(text)) return text;
  try {
    const url = new URL(text);
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error();
    const match = /^\/join\/chat\/(?:planning\/)?([^/]+)$/.exec(url.pathname);
    if (match) return decodeURIComponent(match[1]);
  } catch { /* Report the same actionable input error below. */ }
  throw new Error("Paste a complete ShowPilot crew or Planning invite link.");
}

export function ChatPassRevocation({ orgId, onRevoked }: { orgId: string; onRevoked: (token: string) => void }) {
  const [open, setOpen] = useState(false);
  const [link, setLink] = useState("");
  const [result, setResult] = useState<Result>({ status: "idle" });
  const { confirm, ConfirmDialogEl } = useConfirmDialog();
  const inputId = useId();
  const attempt = useRef(0);
  useEffect(() => () => { attempt.current++; }, []);
  const changeOpen = (value: boolean) => {
    if (!value) {
      attempt.current++;
      if (result.status === "saving") setResult({ status: "failed", message: "The result is unconfirmed. Retry with the same link to confirm it is disabled.", at: Date.now() });
    }
    setOpen(value);
  };
  const disable = async () => {
    const id = ++attempt.current;
    let token: string;
    try { token = chatTokenFromLink(link); }
    catch (error) { setResult({ status: "failed", message: error instanceof Error ? error.message : "Check the link.", at: Date.now() }); return; }
    const accepted = await confirm({ title: "Disable this chat link?", description: "Guests using this link will lose access. Planning members keep their normal workspace access. This cannot be undone.", confirmLabel: "Disable link" });
    if (!accepted || id !== attempt.current) return;
    setResult({ status: "saving" });
    const controller = new AbortController();
    try {
      const saved = await withOperationTimeout(revokeChatPass({ data: { orgId, token }, signal: controller.signal }), 10_000,
        "The result is unconfirmed. Retry with the same link to confirm it is disabled.");
      if (id !== attempt.current) return;
      setResult(saved);
      onRevoked(token);
    } catch (error) {
      if (id === attempt.current) setResult({ status: "failed", message: error instanceof Error ? error.message : "Could not confirm that the link was disabled. Retry.", at: Date.now() });
    } finally { controller.abort(); }
  };
  return <>
    <button type="button" className="min-h-11 rounded-lg border border-board-border px-3 py-2 text-xs text-board-text focus-visible:outline-2" onClick={() => changeOpen(true)}>Disable a chat link</button>
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogContent showCloseButton={false} className="max-h-[calc(100dvh-2rem)] overflow-y-auto border-board-border bg-board-card text-board-text">
        <DialogHeader><DialogTitle>Disable a chat link</DialogTitle><DialogDescription>Paste a crew pass or Planning invite from this workspace. Other links and member access stay active.</DialogDescription></DialogHeader>
        <label htmlFor={inputId} className="text-sm font-medium">Chat invite link</label>
        <textarea id={inputId} value={link} maxLength={16000} rows={3} disabled={result.status === "saving"} onChange={event => { setLink(event.target.value); setResult({ status: "idle" }); }} className="min-w-0 w-full resize-y rounded-lg border border-board-border bg-board-bg p-3 text-sm [overflow-wrap:anywhere]" />
        {result.status === "failed" && <div role="alert" className="text-sm text-red-300"><p>{result.message}</p><p className="mt-1 text-xs">Last attempt: {new Date(result.at).toLocaleTimeString()}</p></div>}
        {result.status === "revoked" && <div role="status" className="text-sm"><p>This link is disabled.</p>{!result.disconnected && <p className="mt-2">New requests are blocked. Existing guest connections may take up to a minute to stop receiving messages. Retry disconnection to check again.</p>}</div>}
        {result.status === "expired" && <p role="status" className="text-sm">This link has already expired and cannot grant access.</p>}
        <div className="flex flex-wrap justify-end gap-2">
          <button type="button" className="min-h-11 rounded-lg border border-board-border px-4" onClick={() => changeOpen(false)}>Close</button>
          {result.status !== "expired" && !(result.status === "revoked" && result.disconnected) && <button type="button" disabled={!link.trim() || result.status === "saving"} onClick={() => void disable()} className="min-h-11 rounded-lg border border-red-400/30 bg-red-500/10 px-4 text-red-300 disabled:opacity-50">{result.status === "saving" ? "Disabling…" : result.status === "failed" ? "Retry disable" : result.status === "revoked" ? "Retry disconnection" : "Review disable"}</button>}
        </div>
      </DialogContent>
    </Dialog>
    {ConfirmDialogEl}
  </>;
}
