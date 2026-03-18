import { createFileRoute, Link } from "@tanstack/react-router";
import { useState, useRef, useEffect, useCallback } from "react";
import {
  Flame,
  List,
  KeyRound,
  CheckCircle2,
  XCircle,
  LogIn,
  LogOut,
  MessageSquare,
  Timer,
  X,
} from "lucide-react";
import { useRouter } from "@tanstack/react-router";
import { getCrewMembers, checkInByMemberId } from "@/lib/data";
import { CheckInList } from "@/components/checkin/CheckInList";
import type { Member } from "@/types";

type CheckInResult = {
  name: string;
  photoUrl: string;
  role: string;
  isOnline: boolean;
};

type ViewMode = "code-entry" | "browse-all";

export const Route = createFileRoute("/$slug/checkin")({
  loader: async ({ context }) => {
    const members = await getCrewMembers({ data: { orgId: context.orgId } });
    return { members: members as Member[], orgId: context.orgId, slug: context.slug };
  },
  component: CheckInPage,
});

function CheckInPage() {
  const { members, orgId, slug } = Route.useLoaderData();
  const router = useRouter();
  const [mode, setMode] = useState<ViewMode>("code-entry");
  const [code, setCode] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<CheckInResult | null>(null);
  const [error, setError] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const resetState = useCallback(() => {
    setResult(null);
    setError("");
    setCode("");
    inputRef.current?.focus();
  }, []);

  // Only auto-reset on error, not on success (user picks action)
  useEffect(() => {
    if (error) {
      timerRef.current = setTimeout(() => {
        resetState();
        router.invalidate();
      }, 4000);
      return () => {
        if (timerRef.current) clearTimeout(timerRef.current);
      };
    }
  }, [error, resetState, router]);

  useEffect(() => {
    if (mode === "code-entry") inputRef.current?.focus();
  }, [mode]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = code.trim();
    if (!trimmed || loading) return;

    setLoading(true);
    setError("");
    setResult(null);

    try {
      const res = await checkInByMemberId({ data: { orgId, memberId: trimmed } });
      if (!res) {
        setError("Member not found");
        setCode("");
      } else {
        setResult(res);
        setCode("");
      }
    } catch {
      setError("Member not found");
      setCode("");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="h-full overflow-auto">
      {/* Header */}
      <div className="sticky top-0 z-10 bg-board-bg/80 backdrop-blur-xl border-b border-board-border px-5 py-4">
        <div className="flex items-center justify-between max-w-lg mx-auto">
          <div>
            <h1 className="text-lg font-bold">
              <span className="text-fire-500">Check-In</span>
            </h1>
            <p className="text-xs text-board-muted">
              {mode === "code-entry"
                ? "Enter your member ID"
                : "Tap to check in or out"}
            </p>
          </div>
          <button
            onClick={() => {
              setMode(mode === "code-entry" ? "browse-all" : "code-entry");
              resetState();
            }}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-board-muted hover:text-board-text hover:bg-board-border/50 border border-board-border transition-colors"
          >
            {mode === "code-entry" ? (
              <>
                <List className="w-3.5 h-3.5" />
                Browse All
              </>
            ) : (
              <>
                <KeyRound className="w-3.5 h-3.5" />
                Use ID
              </>
            )}
          </button>
        </div>
      </div>

      <main className="px-5 py-4 pb-8 max-w-lg mx-auto">
        {mode === "browse-all" ? (
          <CheckInList members={members} />
        ) : (
          <div className="flex flex-col items-center pt-8">
            {/* Code entry form */}
            {!result && !error && (
              <div className="w-full space-y-4 animate-in fade-in duration-200">
                <div className="text-center mb-6">
                  <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-fire-500/10 border border-fire-500/20 mb-4">
                    <KeyRound className="w-8 h-8 text-fire-500" />
                  </div>
                  <p className="text-board-muted text-sm">
                    Enter your member ID to check in or out
                  </p>
                </div>

                <form onSubmit={handleSubmit} className="space-y-3">
                  <input
                    ref={inputRef}
                    type="text"
                    value={code}
                    onChange={(e) => setCode(e.target.value.toUpperCase())}
                    placeholder="e.g. TD3917"
                    autoComplete="off"
                    autoFocus
                    className="w-full px-5 py-4 rounded-2xl bg-board-card border border-board-border text-board-text text-center text-2xl font-mono tracking-[0.2em] uppercase placeholder:text-board-muted/30 placeholder:tracking-[0.2em] focus:outline-none focus:border-fire-500 focus:ring-1 focus:ring-fire-500/30 transition-all"
                  />
                  <button
                    type="submit"
                    disabled={!code.trim() || loading}
                    className="w-full px-5 py-4 rounded-2xl bg-fire-500 text-white font-semibold text-lg hover:bg-fire-600 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                  >
                    {loading ? (
                      <Flame className="w-5 h-5 animate-pulse mx-auto" />
                    ) : (
                      "Check In"
                    )}
                  </button>
                </form>
              </div>
            )}

            {/* Success result */}
            {result && (
              <div className="w-full text-center space-y-5 animate-float-in">
                <div
                  className={`inline-flex items-center justify-center w-20 h-20 rounded-full ${
                    result.isOnline
                      ? "bg-green-500/15 border-2 border-green-500/30"
                      : "bg-orange-500/15 border-2 border-orange-500/30"
                  }`}
                >
                  {result.photoUrl ? (
                    <img
                      src={result.photoUrl}
                      alt={result.name}
                      className="w-full h-full rounded-full object-cover"
                    />
                  ) : result.isOnline ? (
                    <LogIn className="w-9 h-9 text-green-400" />
                  ) : (
                    <LogOut className="w-9 h-9 text-orange-400" />
                  )}
                </div>

                <div>
                  <h2 className="text-2xl font-bold text-board-text">{result.name}</h2>
                  <p className="text-sm text-board-muted mt-1">{result.role}</p>
                </div>

                <div
                  className={`inline-flex items-center gap-2 px-5 py-2.5 rounded-full text-base font-semibold ${
                    result.isOnline
                      ? "bg-green-500/15 text-green-400 border border-green-500/25"
                      : "bg-orange-500/15 text-orange-400 border border-orange-500/25"
                  }`}
                >
                  <CheckCircle2 className="w-5 h-5" />
                  {result.isOnline ? "Checked In" : "Checked Out"}
                </div>

                {/* Post check-in actions */}
                {result.isOnline && (
                  <div className="space-y-2 pt-2 w-full max-w-xs mx-auto">
                    <Link
                      to={`/${slug}/crew-chat`}
                      search={{ name: result.name }}
                      className="flex items-center justify-center gap-2.5 w-full px-5 py-3.5 rounded-2xl bg-fire-500 text-white font-semibold text-base hover:bg-fire-600 transition-colors"
                    >
                      <MessageSquare className="w-5 h-5" />
                      Join Production Chat
                    </Link>
                    <Link
                      to={`/${slug}/rundown`}
                      className="flex items-center justify-center gap-2.5 w-full px-5 py-3.5 rounded-2xl bg-board-card border border-board-border text-board-text font-medium text-base hover:bg-board-border/50 transition-colors"
                    >
                      <Timer className="w-5 h-5" />
                      View Rundown
                    </Link>
                  </div>
                )}

                <button
                  onClick={() => {
                    resetState();
                    router.invalidate();
                  }}
                  className="inline-flex items-center gap-1.5 text-xs text-board-muted/60 hover:text-board-muted transition-colors pt-1"
                >
                  <X className="w-3 h-3" />
                  {result.isOnline ? "Done" : "Back to check-in"}
                </button>
              </div>
            )}

            {/* Error result */}
            {error && (
              <div className="w-full text-center space-y-5 animate-float-in">
                <div className="inline-flex items-center justify-center w-20 h-20 rounded-full bg-red-500/15 border-2 border-red-500/30">
                  <XCircle className="w-9 h-9 text-red-400" />
                </div>
                <div>
                  <h2 className="text-xl font-bold text-red-400">{error}</h2>
                  <p className="text-sm text-board-muted mt-1">
                    Check your ID and try again
                  </p>
                </div>
                <p className="text-xs text-board-muted/60 pt-2">
                  Returning to entry screen...
                </p>
              </div>
            )}
          </div>
        )}
      </main>
    </div>
  );
}
