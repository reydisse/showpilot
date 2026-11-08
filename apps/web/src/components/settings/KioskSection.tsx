import { useOperatorRead } from "@/hooks/useOperatorRead";
import { ReadFailureNotice } from "@/components/layout/ReadFailureNotice";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { CreatedTokenNotice } from "./CreatedTokenNotice";
import { useState, useCallback } from "react";
import { Plus, Trash2, Users, CalendarDays, KeyRound } from "lucide-react";
import { getKioskTeams, type AdminTeam } from "@/lib/kiosk-admin";
import {
  createKioskToken,
  listKioskTokens,
  revokeKioskToken,
} from "@/lib/kiosk";
import { KioskDutyRoster } from "./KioskDutyRoster";
import { KioskTeamEditor } from "./KioskTeamEditor";
import { KioskDisplayControl } from "./KioskDisplayControl";

type Member = { id: string; name: string; image: string | null };

// ─── Section entry point (rendered inside the Settings page) ──

export function KioskSection({
  orgId,
  slug,
  members: rawMembers,
  userId,
}: {
  orgId: string;
  slug: string;
  userId: string;
  members: Array<{ user: { id: string; name: string; image: string | null } }>;
}) {
  const members: Member[] = rawMembers.map((m) => ({
    id: m.user.id,
    name: m.user.name,
    image: m.user.image,
  }));

  const [tab, setTab] = useState<"org" | "roster" | "tokens">("org");
  const readOrganization = useCallback(
    (signal: AbortSignal) => getKioskTeams({ data: { orgId }, signal }),
    [orgId],
  );
  const organizationRead = useOperatorRead<AdminTeam[] | null>({
    key: orgId,
    initialValue: null,
    read: readOrganization,
    errorMessage:
      "Could not read the kiosk organization. Any displayed teams are the last confirmed result.",
  });
  const teams = organizationRead.value ?? [];
  const loading = organizationRead.value === null && !organizationRead.error;
  const reload = organizationRead.invalidate;

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-lg font-semibold text-board-text font-[family-name:var(--font-display)]">
          Kiosk Displays
        </h1>
        <p className="text-xs text-board-muted mt-0.5">
          Org chart and on-duty roster shown on lobby / booth displays
        </p>
      </div>

      <KioskDisplayControl
        key={`${orgId}:${userId}`}
        orgId={orgId}
        userId={userId}
      />

      <div className="flex flex-wrap items-center gap-1.5 mb-5">
        {[
          { id: "org" as const, label: "Org Chart", icon: Users },
          {
            id: "roster" as const,
            label: "On-Duty Roster",
            icon: CalendarDays,
          },
          { id: "tokens" as const, label: "Access Tokens", icon: KeyRound },
        ].map((t) => {
          const Icon = t.icon;
          return (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`flex min-h-11 items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                tab === t.id
                  ? "bg-fire-500/15 text-fire-500 border border-fire-500/25"
                  : "text-board-muted hover:text-board-text border border-transparent"
              }`}
            >
              <Icon className="w-3.5 h-3.5" />
              {t.label}
            </button>
          );
        })}
      </div>

      {tab === "tokens" ? (
        <AccessTokensTab key={orgId} orgId={orgId} slug={slug} />
      ) : tab === "roster" ? (
        <KioskDutyRoster
          key={`${orgId}:${userId}`}
          orgId={orgId}
          userId={userId}
        />
      ) : (
        <>
          <ReadFailureNotice
            error={organizationRead.error}
            refreshing={organizationRead.refreshing}
            retry={organizationRead.retry}
            label="Retry kiosk organization"
          />
          {loading ? (
            <div className="py-10 text-center text-sm text-board-muted">
              Loading kiosk organization…
            </div>
          ) : organizationRead.value === null ? null : (
            <KioskTeamEditor
              key={`${orgId}:${userId}`}
              orgId={orgId}
              userId={userId}
              teams={teams}
              members={members}
              onChange={reload}
              readFailed={Boolean(organizationRead.error)}
            />
          )}
        </>
      )}

      <p className="mt-8 text-[10px] text-board-muted/50">
        Live at <code className="text-board-muted">/api/v1/kiosk/org</code> and{" "}
        <code className="text-board-muted">/api/v1/kiosk/roster</code> for org{" "}
        <span className="font-mono">{slug}</span> (kiosk token required).
      </p>
    </div>
  );
}

// ─── Access Tokens ───────────────────────────────────────────

type KioskTokenRow = {
  id: string;
  label: string;
  expiresAt: string | Date | null;
  createdAt: string | Date;
  view: string;
};

function AccessTokensTab({ orgId, slug }: { orgId: string; slug: string }) {
  const [label, setLabel] = useState("");
  const [purpose, setPurpose] = useState<"board" | "timer" | "overlay">(
    "board",
  );
  const [busy, setBusy] = useState(false);
  const [issuedToken, setIssuedToken] = useState<{
    id: string;
    label: string;
    token: string;
    displayUrl?: string;
  } | null>(null);
  const [removal, setRemoval] = useState<KioskTokenRow | null>(null);
  const [error, setError] = useState<string | null>(null);

  const readTokens = useCallback(
    (signal: AbortSignal) => listKioskTokens({ data: { orgId }, signal }),
    [orgId],
  );
  const tokenRead = useOperatorRead<KioskTokenRow[] | null>({
    key: orgId,
    initialValue: null,
    read: readTokens,
    errorMessage:
      "Could not read kiosk tokens. Any displayed list is the last confirmed result.",
  });
  const tokens = tokenRead.value ?? [];
  const loading = tokenRead.value === null && !tokenRead.error;

  const generate = async () => {
    if (!label.trim() || busy || issuedToken) return;
    setBusy(true);
    setError(null);
    try {
      const created = await createKioskToken({
        data: {
          orgId,
          label: label.trim(),
          view: purpose,
          expiresInDays: null,
        },
      });
      setLabel("");
      const displayUrl =
        created.view === "timer" || created.view === "overlay"
          ? new URL(
              `/${created.view}/${encodeURIComponent(slug)}?${new URLSearchParams({ kioskToken: created.token, ...(created.view === "timer" ? { view: "stage" } : {}) })}`,
              window.location.origin,
            ).href
          : undefined;
      setIssuedToken({ ...created, displayUrl });
      tokenRead.invalidate();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Could not create token.",
      );
    } finally {
      setBusy(false);
    }
  };

  const revoke = async () => {
    if (!removal || busy) return;
    setBusy(true);
    setError(null);
    try {
      await revokeKioskToken({ data: { tokenId: removal.id } });
      if (issuedToken?.id === removal.id) setIssuedToken(null);
      tokenRead.invalidate();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Could not revoke token.",
      );
    } finally {
      setBusy(false);
      setRemoval(null);
    }
  };

  return (
    <div className="space-y-4">
      {error && (
        <p role="alert" className="text-sm text-red-300">
          {error}
        </p>
      )}
      {issuedToken && (
        <CreatedTokenNotice
          key={issuedToken.id}
          label={issuedToken.label}
          token={issuedToken.token}
          displayUrl={issuedToken.displayUrl}
          onDismiss={() => setIssuedToken(null)}
        />
      )}
      <ConfirmDialog
        open={removal !== null}
        onOpenChange={(open) => {
          if (!open && !busy) setRemoval(null);
        }}
        title={`Revoke ${removal?.label ?? "this token"}?`}
        description="Devices using this token will lose access. Generate a replacement before revoking a token still in use."
        confirmLabel="Revoke token"
        loading={busy}
        onConfirm={() => {
          void revoke();
        }}
      />
      <div className="space-y-3 rounded-xl border border-board-border bg-board-card p-3">
        <label className="block text-sm text-board-text">
          Token purpose
          <select
            value={purpose}
            disabled={busy || issuedToken !== null}
            onChange={(event) => {
              const value = event.target.value;
              if (value === "board" || value === "timer" || value === "overlay")
                setPurpose(value);
            }}
            className="mt-2 min-h-11 w-full rounded-lg border border-board-border bg-board-bg px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fire-500"
          >
            <option value="board">Lobby app / data API</option>
            <option value="timer">Stage / confidence display</option>
            <option value="overlay">Lower-thirds overlay</option>
          </select>
        </label>
        <p className="text-sm text-board-muted">
          Stage and overlay tokens include a browser display link. Lobby app
          tokens connect the lobby display software.
        </p>
        <div className="flex items-center gap-2">
          <input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && generate()}
            aria-label="Token label"
            placeholder="Token label (e.g. Lobby rotator)"
            className="min-w-0 min-h-11 flex-1 px-3 py-2 rounded-lg bg-board-bg border border-board-border text-sm text-board-text placeholder:text-board-muted/50 focus:outline-none focus:border-fire-500"
          />
          <button
            onClick={generate}
            disabled={busy || !label.trim() || issuedToken !== null}
            className="min-h-11 shrink-0 flex items-center gap-1.5 px-3 py-2 rounded-lg bg-fire-500 text-white text-xs font-medium hover:bg-fire-600 disabled:opacity-50"
          >
            <Plus className="w-3.5 h-3.5" /> Generate
          </button>
        </div>
        <p className="mt-2 text-[11px] text-board-muted/70">
          Send as{" "}
          <code className="text-board-muted">
            Authorization: Bearer &lt;token&gt;
          </code>{" "}
          to <code className="text-board-muted">/api/v1/kiosk/*</code> for org{" "}
          <span className="font-mono">{slug}</span>. Copy it now — store it
          somewhere safe.
        </p>
      </div>

      <ReadFailureNotice
        error={tokenRead.error}
        refreshing={tokenRead.refreshing}
        retry={tokenRead.retry}
        label="Retry kiosk tokens"
      />
      {loading ? (
        <div className="py-10 text-center text-sm text-board-muted">
          Loading…
        </div>
      ) : tokenRead.value === null ? null : tokens.length === 0 ? (
        <div className="text-center py-10 text-sm text-board-muted">
          No tokens yet — generate one above for your kiosk displays.
        </div>
      ) : (
        <div className="space-y-2">
          {tokens.map((row) => {
            return (
              <div
                key={row.id}
                className="flex items-center gap-2 rounded-xl border border-board-border bg-board-card p-3"
              >
                <KeyRound className="w-4 h-4 text-board-muted shrink-0" />
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium text-board-text truncate">
                    {row.label}
                  </div>
                  <p className="text-xs text-board-muted">
                    {row.view === "timer"
                      ? "Stage / confidence display"
                      : row.view === "overlay"
                        ? "Lower-thirds overlay"
                        : "Lobby app / data API"}
                  </p>
                  <code className="text-[11px] text-board-muted font-mono break-all">
                    Token saved. Its value cannot be shown again.
                  </code>
                </div>
                <button
                  onClick={() => setRemoval(row)}
                  disabled={busy}
                  title="Revoke token"
                  aria-label={`Revoke ${row.label}`}
                  className="min-h-11 min-w-11 flex items-center justify-center p-2 rounded-lg text-board-muted hover:text-red-400 hover:bg-red-500/10 transition-colors shrink-0"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
