import { createFileRoute, Link } from "@tanstack/react-router";
import { useMemo, useState, useEffect, useCallback } from "react";
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
import type { Member } from "@/types";

const MEMBERS_PER_PAGE = 8;

export const Route = createFileRoute("/$slug/show/board")({
  loader: async ({ context }) => {
    const members = await getCrewMembers({ data: { orgId: context.orgId } });
    return { members: members as Member[], slug: context.slug };
  },
  component: ShowBoardPage,
});

function ShowBoardPage() {
  const { members, slug } = Route.useLoaderData();
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [currentPage, setCurrentPage] = useState(0);

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

  const onlineCount = members.filter((m) => m.isOnline).length;

  if (members.length === 0) {
    return (
      <div className="h-full flex flex-col">
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
                to={`/${slug}/admin`}
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

  const currentMembers = pages[currentPage] || [];

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* Status bar */}
      <div className="px-4 sm:px-6 py-4 flex items-center gap-6">
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

      {/* Member grid */}
      <div className="flex-1 px-4 sm:px-6 overflow-hidden">
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 h-full content-start">
          {currentMembers.map((member) => (
            <div
              key={member.id}
              className={`flex flex-col items-center gap-3 p-4 rounded-2xl border transition-all duration-300 ${
                member.isOnline
                  ? "bg-board-card border-fire-500/20"
                  : "bg-board-card/50 border-board-border opacity-60"
              }`}
            >
              <div className="relative">
                <div className="w-16 h-16 rounded-full overflow-hidden bg-board-border">
                  {member.photoUrl ? (
                    <img
                      src={member.photoUrl}
                      alt={member.name}
                      className="w-full h-full object-cover"
                    />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center bg-gradient-to-br from-fire-500/20 to-fire-700/20 text-fire-400 text-xl font-semibold">
                      {member.name.charAt(0)}
                    </div>
                  )}
                </div>
                <div
                  className={`absolute bottom-0 right-0 w-4 h-4 rounded-full border-2 border-board-card ${
                    member.isOnline ? "bg-green-500" : "bg-gray-500"
                  }`}
                />
              </div>
              <div className="text-center">
                <p className="text-sm font-medium text-board-text truncate max-w-[120px]">
                  {member.name}
                </p>
                <p className="text-[11px] text-board-muted truncate max-w-[120px]">
                  {member.role}
                </p>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Footer */}
      <footer className="px-4 sm:px-6 py-4 flex items-center justify-between border-t border-board-border">
        <div className="flex items-center gap-2">
          <Link
            to={`/${slug}/show`}
            className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-board-card border border-board-border hover:border-fire-500/50 transition-colors"
          >
            <ListMusic className="w-4 h-4 text-fire-500" />
            <span className="text-sm font-semibold text-board-text">
              Show Flow
            </span>
          </Link>

          <button
            onClick={toggleFullscreen}
            aria-label={isFullscreen ? "Exit fullscreen" : "Enter fullscreen"}
            className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-board-card border border-board-border hover:border-fire-500/50 transition-colors cursor-pointer"
          >
            {isFullscreen ? (
              <Minimize className="w-4 h-4 text-fire-500" />
            ) : (
              <Maximize className="w-4 h-4 text-fire-500" />
            )}
            <span className="text-sm font-semibold text-board-text">
              {isFullscreen ? "Exit Fullscreen" : "Fullscreen"}
            </span>
          </button>
        </div>

        {totalPages > 1 && (
          <div className="flex items-center gap-3">
            {Array.from({ length: totalPages }).map((_, i) => (
              <span
                key={i}
                className={`w-2.5 h-2.5 rounded-full transition-all duration-300 ${
                  i === currentPage ? "bg-fire-500 scale-125" : "bg-board-border"
                }`}
              />
            ))}
            <span className="text-xs text-board-muted ml-2">
              {currentPage + 1} / {totalPages}
            </span>
          </div>
        )}
      </footer>
    </div>
  );
}
