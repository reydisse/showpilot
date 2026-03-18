import { useState, useEffect, useRef } from "react";
import { useNavigate } from "@tanstack/react-router";
import { ChevronDown, Plus, Check } from "lucide-react";
import { authClient } from "@/lib/auth-client";
import { listUserOrgs } from "@/lib/session";

interface Org {
  id: string;
  name: string;
  slug: string;
  logo: string | null;
}

interface OrgSwitcherProps {
  currentOrg: Org;
  collapsed: boolean;
}

export function OrgSwitcher({ currentOrg, collapsed }: OrgSwitcherProps) {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [orgs, setOrgs] = useState<Org[]>([]);
  const [loading, setLoading] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  async function handleOpen() {
    setOpen(!open);
    if (!open) {
      setLoading(true);
      try {
        const result = await listUserOrgs();
        setOrgs((result as Org[]) ?? []);
      } catch {
        setOrgs([currentOrg]);
      } finally {
        setLoading(false);
      }
    }
  }

  async function switchOrg(org: Org) {
    if (org.id === currentOrg.id) {
      setOpen(false);
      return;
    }
    await authClient.organization.setActive({
      organizationId: org.id,
    });
    setOpen(false);
    navigate({ to: `/${org.slug}` });
  }

  return (
    <div ref={ref} className="relative">
      {/* Trigger */}
      <button
        onClick={handleOpen}
        className={`flex items-center rounded-lg transition-all duration-150 hover:bg-board-border/50 w-full ${
          collapsed ? "justify-center p-2" : "gap-2.5 px-2.5 py-2"
        }`}
      >
        <OrgAvatar org={currentOrg} size={collapsed ? 32 : 28} />
        {!collapsed && (
          <>
            <div className="flex-1 min-w-0 text-left">
              <p className="text-sm font-medium text-board-text truncate leading-tight">
                {currentOrg.name}
              </p>
            </div>
            <ChevronDown
              className={`w-3.5 h-3.5 text-board-muted shrink-0 transition-transform duration-150 ${
                open ? "rotate-180" : ""
              }`}
            />
          </>
        )}
      </button>

      {/* Dropdown */}
      {open && (
        <div
          className={`absolute z-50 mt-1 rounded-xl border border-board-border bg-board-card shadow-2xl py-1.5 ${
            collapsed ? "left-full ml-2 top-0 w-56" : "left-0 right-0 w-full min-w-[220px]"
          }`}
        >
          {loading ? (
            <div className="px-3 py-4 text-center text-xs text-board-muted">
              Loading...
            </div>
          ) : (
            <>
              <div className="px-2.5 py-1.5">
                <p className="text-[10px] font-medium uppercase tracking-widest text-board-muted/50">
                  Organizations
                </p>
              </div>
              {orgs.map((org) => (
                <button
                  key={org.id}
                  onClick={() => switchOrg(org)}
                  className="flex items-center gap-2.5 w-full px-2.5 py-2 rounded-lg mx-0.5 hover:bg-board-border/50 transition-colors"
                  style={{ width: "calc(100% - 4px)" }}
                >
                  <OrgAvatar org={org} size={24} />
                  <span className="flex-1 text-sm text-board-text truncate text-left">
                    {org.name}
                  </span>
                  {org.id === currentOrg.id && (
                    <Check className="w-3.5 h-3.5 text-fire-500 shrink-0" />
                  )}
                </button>
              ))}

              <div className="my-1.5 mx-2.5 h-px bg-board-border" />

              <button
                onClick={() => {
                  setOpen(false);
                  navigate({ to: "/setup" });
                }}
                className="flex items-center gap-2.5 w-full px-2.5 py-2 rounded-lg mx-0.5 hover:bg-board-border/50 transition-colors text-board-muted hover:text-board-text"
                style={{ width: "calc(100% - 4px)" }}
              >
                <div className="w-6 h-6 rounded-md border border-dashed border-board-border flex items-center justify-center">
                  <Plus className="w-3 h-3" />
                </div>
                <span className="text-sm">New organization</span>
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function OrgAvatar({ org, size }: { org: Org; size: number }) {
  return (
    <div
      className="rounded-lg bg-gradient-to-br from-fire-500/20 to-fire-700/20 border border-fire-500/20 flex items-center justify-center shrink-0 overflow-hidden"
      style={{ width: size, height: size }}
    >
      {org.logo ? (
        <img
          src={org.logo}
          alt={org.name}
          className="w-full h-full object-cover"
        />
      ) : (
        <span
          className="font-bold text-fire-400"
          style={{ fontSize: size * 0.4 }}
        >
          {org.name.charAt(0)}
        </span>
      )}
    </div>
  );
}
