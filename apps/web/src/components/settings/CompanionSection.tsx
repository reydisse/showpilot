import { useState, useEffect, useCallback } from "react";
import { Plus, Trash2, KeyRound, Copy, Check, Gamepad2 } from "lucide-react";
import {
  createCompanionToken,
  listCompanionTokens,
  revokeCompanionToken,
} from "@/lib/companion";

// ─────────────────────────────────────────────────────────────
// Companion / Stream Deck setup page.
//
// Generates org-scoped `cmp_` control tokens and prints ready-to-paste
// Bitfocus Companion "Generic HTTP" button recipes for every control action.
// This is what makes the integration usable without external docs.
// ─────────────────────────────────────────────────────────────

type CompanionTokenRow = {
  id: string;
  label: string;
  token: string;
  expiresAt: string | Date | null;
  createdAt: string | Date;
};

function maskToken(t: string): string {
  return t.length > 18 ? `${t.slice(0, 12)}…${t.slice(-6)}` : t;
}

interface ActionRecipe {
  n: number;
  label: string;
  method: "POST" | "GET";
  path: string;
  body?: string;
}

const ACTION_GROUPS: { group: string; actions: ActionRecipe[] }[] = [
  {
    group: "Transport (1–6)",
    actions: [
      { n: 1, label: "Start / resume timer", method: "POST", path: "/api/v1/companion/timer/start", body: "{}" },
      { n: 2, label: "Stop timer", method: "POST", path: "/api/v1/companion/timer/stop", body: "{}" },
      { n: 3, label: "Next item", method: "POST", path: "/api/v1/companion/rundown/next", body: "{}" },
      { n: 4, label: "Previous item", method: "POST", path: "/api/v1/companion/rundown/previous", body: "{}" },
      { n: 5, label: "Add 1 min", method: "POST", path: "/api/v1/companion/timer/add", body: '{"seconds":60}' },
      { n: 6, label: "Subtract 1 min", method: "POST", path: "/api/v1/companion/timer/subtract", body: '{"seconds":60}' },
    ],
  },
  {
    group: "ProPresenter lyrics (7–8)",
    actions: [
      { n: 7, label: "Lyrics on", method: "POST", path: "/api/v1/companion/propresenter/lyrics", body: '{"enabled":true}' },
      { n: 8, label: "Lyrics off", method: "POST", path: "/api/v1/companion/propresenter/lyrics", body: '{"enabled":false}' },
    ],
  },
  {
    group: "Kiosk (9)",
    actions: [
      { n: 9, label: "Blank / restore displays", method: "POST", path: "/api/v1/companion/kiosk/blank", body: '{"blanked":true}' },
    ],
  },
  {
    group: "Stream (10)",
    actions: [
      { n: 10, label: "Go live (connect destinations)", method: "POST", path: "/api/v1/companion/stream/go-live", body: "{}" },
      { n: 10, label: "Stop all destinations", method: "POST", path: "/api/v1/companion/stream/stop", body: "{}" },
    ],
  },
  {
    group: "Lower thirds (11)",
    actions: [
      {
        n: 11,
        label: "Trigger lower third",
        method: "POST",
        path: "/api/v1/companion/lower-third/trigger",
        body: '{"payload":{"id":"lt1","type":"freetext","line1":"Pastor John","line2":"Senior Pastor","style":"default"}}',
      },
      { n: 11, label: "Clear lower third", method: "POST", path: "/api/v1/companion/lower-third/clear", body: "{}" },
    ],
  },
  {
    group: "Feedback (button state)",
    actions: [
      { n: 0, label: "Read live state (for button feedback)", method: "GET", path: "/api/v1/companion/state" },
    ],
  },
];

export function CompanionSection({ orgId, slug }: { orgId: string; slug: string }) {
  const [tokens, setTokens] = useState<CompanionTokenRow[]>([]);
  const [label, setLabel] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [revealed, setRevealed] = useState<Set<string>>(new Set());
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [copiedRecipe, setCopiedRecipe] = useState<string | null>(null);
  const [activeTokenId, setActiveTokenId] = useState<string | null>(null);

  const baseUrl = typeof window !== "undefined" ? window.location.origin : "https://showpilot.tech";

  const reload = useCallback(async () => {
    const rows = (await listCompanionTokens({ data: { orgId } })) as CompanionTokenRow[];
    setTokens(rows);
    setActiveTokenId((prev) => prev ?? rows[0]?.id ?? null);
    setLoading(false);
  }, [orgId]);

  useEffect(() => {
    reload();
  }, [reload]);

  const generate = async () => {
    if (!label.trim() || busy) return;
    setBusy(true);
    try {
      const created = (await createCompanionToken({
        data: { orgId, label: label.trim(), expiresInDays: null },
      })) as CompanionTokenRow;
      setLabel("");
      setRevealed((prev) => new Set(prev).add(created.id));
      setActiveTokenId(created.id);
      await reload();
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (id: string) => {
    await revokeCompanionToken({ data: { tokenId: id } });
    await reload();
  };

  const copy = async (text: string, key: string, kind: "token" | "recipe") => {
    await navigator.clipboard.writeText(text);
    if (kind === "token") {
      setCopiedId(key);
      setTimeout(() => setCopiedId((c) => (c === key ? null : c)), 1500);
    } else {
      setCopiedRecipe(key);
      setTimeout(() => setCopiedRecipe((c) => (c === key ? null : c)), 1500);
    }
  };

  const toggleReveal = (id: string) =>
    setRevealed((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  const activeToken = tokens.find((t) => t.id === activeTokenId);
  const tokenForExamples = activeToken
    ? revealed.has(activeToken.id)
      ? activeToken.token
      : "<your-token>"
    : "<your-token>";

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-lg font-semibold text-board-text font-[family-name:var(--font-display)]">
          Companion / Stream Deck
        </h1>
        <p className="text-xs text-board-muted mt-0.5">
          Drive ShowPilot from a Stream Deck via Bitfocus Companion's Generic HTTP module — no custom module needed.
        </p>
      </div>

      {/* Base URL */}
      <div className="rounded-xl border border-board-border bg-board-card p-3 mb-4">
        <div className="text-[10px] font-semibold uppercase tracking-widest text-board-muted mb-1">
          Base URL
        </div>
        <code className="text-sm text-board-text font-mono break-all">{baseUrl}</code>
        <p className="mt-2 text-[11px] text-board-muted/70">
          Every request authenticates with{" "}
          <code className="text-board-muted">Authorization: Bearer &lt;cmp_token&gt;</code>. The org
          (<span className="font-mono">{slug}</span>) is resolved from the token — no org id in the URL.
        </p>
      </div>

      {/* Token management */}
      <div className="rounded-xl border border-board-border bg-board-card p-3 mb-4">
        <div className="flex items-center gap-2">
          <input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && generate()}
            placeholder="Token label (e.g. Booth Stream Deck)"
            className="flex-1 px-3 py-2 rounded-lg bg-board-bg border border-board-border text-sm text-board-text placeholder:text-board-muted/50 focus:outline-none focus:border-fire-500"
          />
          <button
            onClick={generate}
            disabled={busy || !label.trim()}
            className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-fire-500 text-white text-xs font-medium hover:bg-fire-600 disabled:opacity-50"
          >
            <Plus className="w-3.5 h-3.5" /> Generate
          </button>
        </div>
        <p className="mt-2 text-[11px] text-board-muted/70">
          Shown once — copy it now and store it safely. Revoke any time.
        </p>

        {loading ? (
          <div className="py-6 text-center text-sm text-board-muted">Loading…</div>
        ) : tokens.length === 0 ? (
          <div className="text-center py-6 text-sm text-board-muted">
            No tokens yet — generate one above for your Stream Deck.
          </div>
        ) : (
          <div className="space-y-2 mt-3">
            {tokens.map((row) => {
              const shown = revealed.has(row.id);
              const isActive = row.id === activeTokenId;
              return (
                <div
                  key={row.id}
                  className={`flex items-center gap-2 rounded-xl border bg-board-bg p-3 ${
                    isActive ? "border-fire-500/40" : "border-board-border"
                  }`}
                >
                  <button
                    onClick={() => setActiveTokenId(row.id)}
                    title="Use this token in the examples below"
                    className={`shrink-0 ${isActive ? "text-fire-500" : "text-board-muted hover:text-board-text"}`}
                  >
                    <KeyRound className="w-4 h-4" />
                  </button>
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium text-board-text truncate">{row.label}</div>
                    <code className="text-[11px] text-board-muted font-mono break-all">
                      {shown ? row.token : maskToken(row.token)}
                    </code>
                  </div>
                  <button
                    onClick={() => toggleReveal(row.id)}
                    className="px-2 py-1 rounded-lg text-[11px] text-board-muted hover:text-board-text hover:bg-board-border/50 transition-colors shrink-0"
                  >
                    {shown ? "Hide" : "Reveal"}
                  </button>
                  <button
                    onClick={() => copy(row.token, row.id, "token")}
                    title="Copy token"
                    className="p-2 rounded-lg text-board-muted hover:text-board-text hover:bg-board-border/50 transition-colors shrink-0"
                  >
                    {copiedId === row.id ? (
                      <Check className="w-4 h-4 text-green-500" />
                    ) : (
                      <Copy className="w-4 h-4" />
                    )}
                  </button>
                  <button
                    onClick={() => revoke(row.id)}
                    title="Revoke token"
                    className="p-2 rounded-lg text-board-muted hover:text-red-400 hover:bg-red-500/10 transition-colors shrink-0"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Button recipes */}
      <div className="flex items-center gap-2 mb-3">
        <Gamepad2 className="w-4 h-4 text-board-muted" />
        <h2 className="text-[11px] font-semibold uppercase tracking-widest text-board-muted">
          Stream Deck button recipes
        </h2>
        {activeToken && (
          <span className="text-[10px] text-board-muted/60">
            using <span className="font-mono text-board-muted">{activeToken.label}</span>
            {!revealed.has(activeToken.id) && " (reveal it to embed the real token)"}
          </span>
        )}
      </div>

      <div className="space-y-5">
        {ACTION_GROUPS.map((g) => (
          <div key={g.group}>
            <div className="text-[10px] font-semibold uppercase tracking-widest text-fire-500/80 mb-2">
              {g.group}
            </div>
            <div className="space-y-2">
              {g.actions.map((a, i) => {
                const url = `${baseUrl}${a.path}`;
                const recipeKey = `${g.group}-${i}`;
                const curl = [
                  `curl -X ${a.method} '${url}'`,
                  `  -H 'Authorization: Bearer ${tokenForExamples}'`,
                  ...(a.body ? [`  -H 'Content-Type: application/json'`, `  -d '${a.body}'`] : []),
                ].join(" \\\n");
                return (
                  <div key={recipeKey} className="rounded-xl border border-board-border bg-board-card p-3">
                    <div className="flex items-center gap-2 mb-1.5">
                      <span className="shrink-0 w-6 text-center text-[10px] font-bold text-board-muted/70 tabular-nums">
                        {a.n > 0 ? a.n : "·"}
                      </span>
                      <span className="text-sm font-medium text-board-text flex-1">{a.label}</span>
                      <span
                        className={`shrink-0 px-1.5 py-0.5 rounded text-[9px] font-bold uppercase tracking-wider ${
                          a.method === "GET" ? "bg-blue-500/15 text-blue-400" : "bg-green-500/15 text-green-400"
                        }`}
                      >
                        {a.method}
                      </span>
                      <button
                        onClick={() => copy(curl, recipeKey, "recipe")}
                        title="Copy as curl"
                        className="p-1.5 rounded-lg text-board-muted hover:text-board-text hover:bg-board-border/50 transition-colors shrink-0"
                      >
                        {copiedRecipe === recipeKey ? (
                          <Check className="w-3.5 h-3.5 text-green-500" />
                        ) : (
                          <Copy className="w-3.5 h-3.5" />
                        )}
                      </button>
                    </div>
                    <code className="block text-[11px] text-board-muted font-mono break-all pl-8">
                      {a.method} {a.path}
                      {a.body && a.body !== "{}" && (
                        <span className="text-board-muted/60"> · {a.body}</span>
                      )}
                    </code>
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>

      <p className="mt-8 text-[10px] text-board-muted/50">
        In Companion, add a button → Generic HTTP → paste the method, URL, header and body above.
        Lower thirds require Cloud Graphics enabled for this org.
      </p>
    </div>
  );
}
