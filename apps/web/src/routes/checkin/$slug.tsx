import { createFileRoute, redirect } from "@tanstack/react-router";
import { BoardSkeleton } from "@/components/ui/Skeleton";
import { useState, useRef, useEffect, useCallback } from "react";
import {
  Flame,
  KeyRound,
  CheckCircle2,
  XCircle,
  LogIn,
  LogOut,
  X,
} from "lucide-react";
import { useRouter } from "@tanstack/react-router";
import {
  getPublicCheckInOrg,
  publicCheckInByMemberId,
  getPublicCrewMemberByMemberId,
} from "@/lib/data";

type CheckInResult = {
  memberId: string;
  name: string;
  photoUrl: string;
  role: string;
  isOnline: boolean;
};

const rememberedMemberKey = (slug: string) => `showpilot-checkin:${slug}:memberId`;

export const Route = createFileRoute("/checkin/$slug")({
  pendingComponent: () => <BoardSkeleton />,
  loader: async ({ params }) => {
    const org = await getPublicCheckInOrg({ data: { slug: params.slug } });
    if (!org) {
      throw redirect({ to: "/" });
    }
    return { slug: params.slug, orgName: org.name };
  },
  component: PublicCheckInPage,
});

function PublicCheckInPage() {
  const { slug, orgName } = Route.useLoaderData();
  const router = useRouter();
  const [code, setCode] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<CheckInResult | null>(null);
  const [error, setError] = useState("");
  const [rememberedMember, setRememberedMember] = useState<CheckInResult | null>(null);
  const [restoringMember, setRestoringMember] = useState(true);
  const inputRef = useRef<HTMLInputElement>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const resetState = useCallback(() => {
    setResult(null);
    setError("");
    setCode("");
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    let cancelled = false;

    const restoreRememberedMember = async () => {
      if (typeof window === "undefined") return;
      const memberId = window.localStorage.getItem(rememberedMemberKey(slug));
      if (!memberId) {
        if (!cancelled) setRestoringMember(false);
        return;
      }

      try {
        const member = await getPublicCrewMemberByMemberId({ data: { slug, memberId } });
        if (!cancelled) {
          setRememberedMember(member ? { ...member } : null);
        }
        if (!member) {
          window.localStorage.removeItem(rememberedMemberKey(slug));
        }
      } catch {
        if (!cancelled) {
          setRememberedMember(null);
        }
      } finally {
        if (!cancelled) setRestoringMember(false);
      }
    };

    void restoreRememberedMember();

    return () => {
      cancelled = true;
    };
  }, [slug]);

  useEffect(() => {
    if (!error) return;
    timerRef.current = setTimeout(() => {
      resetState();
      router.invalidate();
    }, 4000);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [error, resetState, router]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = code.trim();
    if (!trimmed || loading) return;

    setLoading(true);
    setError("");
    setResult(null);

    try {
      const res = await publicCheckInByMemberId({ data: { slug, memberId: trimmed } });
      if (!res) {
        setError("Member not found");
        setCode("");
      } else {
        if (typeof window !== "undefined") {
          window.localStorage.setItem(rememberedMemberKey(slug), res.memberId);
        }
        setResult(res);
        setRememberedMember(res);
        setCode("");
      }
    } catch {
      setError("Member not found");
      setCode("");
    } finally {
      setLoading(false);
    }
  };

  const handleQuickToggle = async () => {
    if (!rememberedMember || loading) return;

    setLoading(true);
    setError("");
    setResult(null);

    try {
      const res = await publicCheckInByMemberId({ data: { slug, memberId: rememberedMember.memberId } });
      if (!res) {
        setError("Member not found");
        setRememberedMember(null);
        if (typeof window !== "undefined") {
          window.localStorage.removeItem(rememberedMemberKey(slug));
        }
      } else {
        if (typeof window !== "undefined") {
          window.localStorage.setItem(rememberedMemberKey(slug), res.memberId);
        }
        setResult(res);
        setRememberedMember(res);
      }
    } catch {
      setError("Unable to update check-in right now");
    } finally {
      setLoading(false);
    }
  };

  const clearRememberedMember = () => {
    if (typeof window !== "undefined") {
      window.localStorage.removeItem(rememberedMemberKey(slug));
    }
    setRememberedMember(null);
    setResult(null);
    setCode("");
    setError("");
    inputRef.current?.focus();
  };

  return (
    <div className="min-h-screen bg-board-bg text-board-text">
      <div className="sticky top-0 z-10 bg-board-bg/80 backdrop-blur-xl border-b border-board-border px-5 py-4">
        <div className="max-w-lg mx-auto">
          <h1 className="text-lg font-bold">
            <span className="text-fire-500">Check-In</span>
          </h1>
          <p className="text-xs text-board-muted mt-1">{orgName}</p>
          <p className="text-xs text-board-muted">Enter your member ID</p>
        </div>
      </div>

      <main className="px-5 py-4 pb-8 max-w-lg mx-auto">
        <div className="flex flex-col items-center pt-8">
          {!result && !error && !restoringMember && rememberedMember && (
            <div className="w-full mb-6 rounded-2xl bg-board-card border border-board-border p-4 text-center space-y-4">
              <div>
                <p className="text-xs uppercase tracking-[0.2em] text-board-muted mb-2">Welcome back</p>
                <h2 className="text-xl font-bold text-board-text">{rememberedMember.name}</h2>
                <p className="text-sm text-board-muted mt-1">{rememberedMember.role}</p>
              </div>
              <button
                onClick={handleQuickToggle}
                disabled={loading}
                className={`w-full px-5 py-4 rounded-2xl font-semibold text-lg transition-colors ${
                  rememberedMember.isOnline
                    ? "bg-orange-500 text-white hover:bg-orange-600"
                    : "bg-fire-500 text-white hover:bg-fire-600"
                } disabled:opacity-40 disabled:cursor-not-allowed`}
              >
                {loading
                  ? "Working..."
                  : rememberedMember.isOnline
                    ? "Check Out"
                    : "Check In Again"}
              </button>
              <button
                onClick={clearRememberedMember}
                className="text-xs text-board-muted hover:text-board-text transition-colors"
              >
                Use a different ID
              </button>
            </div>
          )}

          {!result && !error && (
            <div className="w-full space-y-4 animate-in fade-in duration-200">
              <div className="text-center mb-6">
                <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-fire-500/10 border border-fire-500/20 mb-4">
                  <KeyRound className="w-8 h-8 text-fire-500" />
                </div>
                <p className="text-board-muted text-sm">
                  {rememberedMember
                    ? "Or enter a different member ID"
                    : "Enter your member ID to check in or out"}
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
                  {loading ? <Flame className="w-5 h-5 animate-pulse mx-auto" /> : "Check In"}
                </button>
              </form>
            </div>
          )}

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

              <button
                onClick={() => {
                  resetState();
                  router.invalidate();
                }}
                className="inline-flex items-center gap-1.5 text-xs text-board-muted/60 hover:text-board-muted transition-colors pt-1"
              >
                <X className="w-3 h-3" />
                Done
              </button>
            </div>
          )}

          {error && (
            <div className="w-full text-center space-y-5 animate-float-in">
              <div className="inline-flex items-center justify-center w-20 h-20 rounded-full bg-red-500/15 border-2 border-red-500/30">
                <XCircle className="w-9 h-9 text-red-400" />
              </div>
              <div>
                <h2 className="text-xl font-bold text-red-400">{error}</h2>
                <p className="text-sm text-board-muted mt-1">Check your ID and try again</p>
              </div>
              <p className="text-xs text-board-muted/60 pt-2">Returning to entry screen...</p>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
