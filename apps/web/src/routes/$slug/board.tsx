import { createFileRoute, Link } from "@tanstack/react-router";
import { BoardSkeleton } from "@/components/ui/Skeleton";
import { useMemo, useState, useEffect, useCallback } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { QRCodeSVG } from "qrcode.react";
import {
  Flame,
  ListMusic,
  Maximize,
  Minimize,
  UserPlus,
  Radio,
  LayoutDashboard,
  ArrowRight,
} from "lucide-react";
import { getCrewMembers } from "@/lib/data";
import { getClockFormat } from "@/lib/settings";
import { formatTime, type ClockFormat } from "@/lib/utils";
import type { Member } from "@/types";

const MEMBERS_PER_PAGE = 8;

export const Route = createFileRoute("/$slug/board")({
  pendingComponent: () => <BoardSkeleton />,
  loader: async ({ context }) => {
    const { withPermission } = await import("@/lib/route-permissions");
    await withPermission(context.role, "showboard:view", context.slug, context.orgId);
    const [members, clockFormat] = await Promise.all([
      getCrewMembers({ data: { orgId: context.orgId } }),
      getClockFormat({ data: { orgId: context.orgId } }),
    ]);
    return { members: members as Member[], slug: context.slug, orgId: context.orgId, clockFormat };
  },
  component: ShowBoardPage,
});

// ─── Clock Hook ──────────────────────────────────────────────

function useClock() {
  const [time, setTime] = useState(new Date());
  useEffect(() => {
    const interval = setInterval(() => setTime(new Date()), 1000);
    return () => clearInterval(interval);
  }, []);
  return time;
}

// ─── Board Header ────────────────────────────────────────────

function BoardHeader({ clockFormat }: { clockFormat: ClockFormat }) {
  const time = useClock();

  const formattedTime = formatTime(time, clockFormat);

  const formattedDate = time.toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });

  return (
    <header className="flex items-center justify-between px-4 sm:px-6 py-3 md:py-5">
      <div className="flex items-center gap-3 md:gap-4">
        <div className="w-9 h-9 md:w-12 md:h-12 rounded-xl bg-gradient-to-br from-fire-500/20 to-fire-800/10 border border-fire-500/20 flex items-center justify-center">
          <Flame className="w-5 h-5 md:w-7 md:h-7 text-fire-500" />
        </div>
        <div>
          <h1 className="text-lg md:text-3xl font-bold font-[family-name:var(--font-display)] tracking-tight">
            <span className="text-fire-500">ShowPilot</span>{" "}
            <span className="text-board-text hidden sm:inline">Production</span>
          </h1>
          <p className="text-board-muted text-xs md:text-sm tracking-widest uppercase hidden sm:block">
            Production Board
          </p>
        </div>
      </div>
      <div className="text-right">
        <p className="text-xl md:text-3xl font-bold font-[family-name:var(--font-display)] text-board-text tabular-nums">
          {formattedTime}
        </p>
        <p className="text-xs md:text-sm text-board-muted hidden sm:block">{formattedDate}</p>
      </div>
    </header>
  );
}

// ─── Member Card ─────────────────────────────────────────────

function MemberCard({ member }: { member: Member }) {
  const initials = member.name
    .split(" ")
    .map((n) => n[0])
    .join("")
    .slice(0, 2);

  return (
    <div
      className={`flex flex-col items-center justify-center p-3 md:p-6 rounded-xl md:rounded-2xl transition-all duration-700 bg-board-card border ${
        member.isOnline
          ? "border-fire-500/30 animate-ember-glow"
          : "border-board-border opacity-50"
      }`}
    >
      <div className="relative w-[70px] h-[70px] md:w-[110px] md:h-[110px]">
        {member.photoUrl ? (
          <img
            src={member.photoUrl}
            alt={member.name}
            className="w-full h-full rounded-full object-cover"
          />
        ) : (
          <div className="w-full h-full rounded-full bg-board-border flex items-center justify-center text-xl md:text-3xl font-bold text-board-muted font-[family-name:var(--font-display)]">
            {initials}
          </div>
        )}
        <span
          className={`absolute bottom-0.5 right-0.5 md:bottom-1 md:right-1 h-4 w-4 md:h-5 md:w-5 rounded-full border-2 md:border-[3px] border-board-card ${
            member.isOnline ? "bg-green-500 animate-pulse-glow" : "bg-gray-600"
          }`}
        />
      </div>

      <h3 className="mt-2 md:mt-4 text-sm md:text-xl font-semibold font-[family-name:var(--font-display)] text-board-text text-center leading-tight">
        {member.name}
      </h3>
      <p className="mt-0.5 md:mt-1 text-xs md:text-base text-board-muted text-center">
        {member.role}
      </p>
    </div>
  );
}

// ─── Member Grid ─────────────────────────────────────────────

function MemberGrid({ members }: { members: Member[] }) {
  return (
    <div className="w-full h-full flex items-center justify-center px-4 sm:px-6">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 md:gap-5 w-full max-w-[1600px]">
        {members.map((member) => (
          <MemberCard key={member.id} member={member} />
        ))}
      </div>
    </div>
  );
}

// ─── Carousel ────────────────────────────────────────────────

const carouselVariants = {
  enter: { opacity: 0, x: 60 },
  center: { opacity: 1, x: 0 },
  exit: { opacity: 0, x: -60 },
};

function Carousel({
  pages,
  currentPage,
}: {
  pages: Member[][];
  currentPage: number;
}) {
  return (
    <div className="relative w-full flex-1 overflow-hidden">
      <AnimatePresence mode="wait">
        <motion.div
          key={currentPage}
          variants={carouselVariants}
          initial="enter"
          animate="center"
          exit="exit"
          transition={{ duration: 0.6, ease: "easeInOut" }}
          className="absolute inset-0 flex items-center justify-center"
        >
          <MemberGrid members={pages[currentPage] || []} />
        </motion.div>
      </AnimatePresence>
    </div>
  );
}

// ─── QR Code Panel ───────────────────────────────────────────

function QRCodePanel({ slug }: { slug: string }) {
  const [checkinUrl, setCheckinUrl] = useState("");

  useEffect(() => {
    setCheckinUrl(`${window.location.origin}/checkin/${slug}`);
  }, [slug]);

  if (!checkinUrl) return null;

  return (
    <div className="flex items-center gap-4">
      <div className="bg-white p-2.5 rounded-xl">
        <QRCodeSVG
          value={checkinUrl}
          size={90}
          level="M"
          bgColor="#ffffff"
          fgColor="#0a0a0a"
        />
      </div>
      <div>
        <p className="text-fire-500 font-[family-name:var(--font-display)] font-semibold text-base">
          Scan to Serve
        </p>
        <p className="text-board-muted text-xs mt-0.5">
          Open your camera and point at the code
        </p>
      </div>
    </div>
  );
}

// ─── Show Board Page ─────────────────────────────────────────

function ShowBoardPage() {
  const { members: initialMembers, slug, orgId, clockFormat } = Route.useLoaderData();
  const [members, setMembers] = useState(initialMembers);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [currentPage, setCurrentPage] = useState(0);

  useEffect(() => {
    let cancelled = false;

    const refreshMembers = async () => {
      try {
        const latest = await getCrewMembers({ data: { orgId } });
        if (!cancelled) {
          setMembers(latest as Member[]);
        }
      } catch {
        // Keep showing the last known board state.
      }
    };

    const interval = setInterval(refreshMembers, 3000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [orgId]);

  useEffect(() => {
    const handleChange = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", handleChange);
    return () => document.removeEventListener("fullscreenchange", handleChange);
  }, []);

  const toggleFullscreen = useCallback(() => {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen?.().catch(() => {});
    } else {
      document.exitFullscreen?.().catch(() => {});
    }
  }, []);

  const sortedMembers = useMemo(() => {
    return [...members].sort((a, b) => {
      if (a.isOnline !== b.isOnline) return a.isOnline ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  }, [members]);

  const pages = useMemo(() => {
    const result: Member[][] = [];
    for (let i = 0; i < sortedMembers.length; i += MEMBERS_PER_PAGE) {
      result.push(sortedMembers.slice(i, i + MEMBERS_PER_PAGE));
    }
    return result.length > 0 ? result : [[]];
  }, [sortedMembers]);

  const totalPages = pages.length;

  // Auto-rotate carousel
  useEffect(() => {
    if (totalPages <= 1) return;
    const interval = setInterval(() => {
      setCurrentPage((p) => (p + 1) % totalPages);
    }, 8000);
    return () => clearInterval(interval);
  }, [totalPages]);

  // Reset if total pages shrinks
  useEffect(() => {
    if (currentPage >= totalPages) setCurrentPage(0);
  }, [currentPage, totalPages]);

  const onlineCount = members.filter((m) => m.isOnline).length;

  if (members.length === 0) {
    return (
      <div className="h-full flex flex-col">
        <BoardHeader clockFormat={clockFormat} />
        <div className="flex-1 flex items-center justify-center px-4">
          <div className="w-full max-w-lg animate-float-in">
            <div className="flex justify-center mb-8">
              <div className="relative">
                <div className="absolute inset-0 rounded-3xl bg-fire-500/10 blur-2xl scale-150" />
                <div className="relative w-20 h-20 rounded-2xl bg-gradient-to-br from-fire-500/20 to-fire-800/10 border border-fire-500/20 flex items-center justify-center">
                  <Flame className="w-9 h-9 text-fire-500/70" />
                </div>
                <div className="absolute -top-2 -right-2 w-4 h-4 rounded-full bg-fire-500/20 border border-fire-500/30" />
                <div className="absolute -bottom-1 -left-3 w-3 h-3 rounded-full bg-fire-500/15 border border-fire-500/20" />
              </div>
            </div>

            <h2 className="text-center font-[family-name:var(--font-display)] text-2xl font-bold text-board-text mb-2">
              Your show board is ready
            </h2>
            <p className="text-center text-board-muted text-sm leading-relaxed max-w-sm mx-auto mb-10">
              Add your team members and they&apos;ll appear here in real time as
              they check in for service.
            </p>

            <div className="flex justify-center mb-12">
              <Link
                to="/$slug/admin"
                params={{ slug }}
                className="group flex items-center gap-2.5 px-6 py-3 rounded-xl font-[family-name:var(--font-display)] font-semibold text-black transition-all duration-200 hover:shadow-lg hover:shadow-fire-500/20 active:scale-[0.98]"
                style={{
                  background:
                    "linear-gradient(135deg, #FFC107 0%, #FF8F00 100%)",
                }}
              >
                <UserPlus className="w-5 h-5" />
                Add Team Members
                <ArrowRight className="w-4 h-4 transition-transform duration-200 group-hover:translate-x-0.5" />
              </Link>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              {[
                {
                  icon: UserPlus,
                  title: "Build your crew",
                  desc: "Add names, roles, and photos for everyone on the team",
                },
                {
                  icon: Radio,
                  title: "Live check-in",
                  desc: "Members scan a badge or tap in — status updates instantly",
                },
                {
                  icon: LayoutDashboard,
                  title: "See it all",
                  desc: "Full-screen board shows who's on crew right now",
                },
              ].map((card) => (
                <div
                  key={card.title}
                  className="rounded-xl border border-board-border/60 bg-board-card/50 p-4 text-center"
                >
                  <div className="mx-auto mb-3 w-10 h-10 rounded-lg bg-fire-500/10 flex items-center justify-center">
                    <card.icon className="w-5 h-5 text-fire-500/70" />
                  </div>
                  <p className="text-sm font-medium text-board-text mb-1">
                    {card.title}
                  </p>
                  <p className="text-xs text-board-muted leading-relaxed">
                    {card.desc}
                  </p>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* Board header with logo + clock */}
      <BoardHeader clockFormat={clockFormat} />

      {/* Status bar */}
      <div className="px-4 sm:px-6 pb-3 flex items-center gap-6">
        <div className="flex items-center gap-2">
          <span className="w-2.5 h-2.5 rounded-full bg-green-500" />
          <span className="text-sm text-board-muted">
            <span className="text-board-text font-semibold">{onlineCount}</span>{" "}
            on crew
          </span>
        </div>
        <div className="flex items-center gap-2">
          <span className="w-2.5 h-2.5 rounded-full bg-gray-600" />
          <span className="text-sm text-board-muted">
            <span className="text-board-text font-semibold">
              {members.length - onlineCount}
            </span>{" "}
            offline
          </span>
        </div>
        <div className="h-px flex-1 bg-board-border" />
      </div>

      {/* Carousel with framer-motion transitions */}
      <Carousel pages={pages} currentPage={currentPage} />

      {/* Footer: QR code + nav + page dots */}
      <footer className="px-4 sm:px-6 py-3 md:py-4 flex flex-col md:flex-row items-center justify-between gap-3 border-t border-board-border">
        <div className="hidden md:block">
          <QRCodePanel slug={slug} />
        </div>

        <div className="flex items-center gap-3 md:gap-6 w-full md:w-auto justify-center md:justify-end">
          <div className="flex items-center gap-2">
            <Link
              to="/$slug/show"
              params={{ slug }}
              className="flex items-center gap-2 px-3 md:px-4 py-2.5 rounded-xl bg-board-card border border-board-border hover:border-fire-500/50 transition-colors min-h-[44px]"
            >
              <ListMusic className="w-4 h-4 text-fire-500" />
              <span className="text-sm font-semibold text-board-text hidden sm:inline">
                Show Flow
              </span>
            </Link>

            <button
              onClick={toggleFullscreen}
              aria-label={isFullscreen ? "Exit fullscreen" : "Enter fullscreen"}
              className="flex items-center gap-2 px-3 md:px-4 py-2.5 rounded-xl bg-board-card border border-board-border hover:border-fire-500/50 transition-colors cursor-pointer min-h-[44px]"
            >
              {isFullscreen ? (
                <Minimize className="w-4 h-4 text-fire-500" />
              ) : (
                <Maximize className="w-4 h-4 text-fire-500" />
              )}
              <span className="text-sm font-semibold text-board-text hidden sm:inline">
                {isFullscreen ? "Exit" : "Fullscreen"}
              </span>
            </button>
          </div>

          {/* Page dots */}
          {totalPages > 1 && (
            <div className="flex items-center gap-2 md:gap-3">
              {Array.from({ length: totalPages }).map((_, i) => (
                <span
                  key={i}
                  className={`w-2 h-2 md:w-2.5 md:h-2.5 rounded-full transition-all duration-300 ${
                    i === currentPage ? "bg-fire-500 scale-125" : "bg-board-border"
                  }`}
                />
              ))}
              <span className="text-xs text-board-muted ml-1">
                {currentPage + 1}/{totalPages}
              </span>
            </div>
          )}
        </div>
      </footer>
    </div>
  );
}
