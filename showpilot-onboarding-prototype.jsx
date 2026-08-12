import { useState, useEffect, useRef, useMemo } from "react";
import {
  Headset, ClipboardList, Timer, Palette, Building2, SlidersHorizontal,
  ArrowRight, Check, QrCode, Plus, ChevronRight,
} from "lucide-react";

// ─────────────────────────────────────────────────────────────
// ShowPilot onboarding prototype — "First show in 5 minutes"
// Five scenes, broadcast-dark, every animation ≤ 400ms, all skippable.
// Prototype only: no backend, seeding is simulated.
// ─────────────────────────────────────────────────────────────

const T = {
  stage: "#0A0B0D",
  panel: "#13151A",
  panelHover: "#191C22",
  border: "#262A32",
  text: "#E9EBEE",
  muted: "#8B919C",
  faint: "#5A6069",
  amber: "#FFB224",   // timecode LED
  red: "#E5484D",     // broadcast tally
  green: "#3DD68C",   // safe / available
};

const FONT_DISPLAY = "'Archivo', 'Inter', system-ui, sans-serif";
const FONT_MONO = "'JetBrains Mono', ui-monospace, 'SF Mono', Menlo, monospace";

const TEMPLATES = [
  {
    id: "sunday", name: "Sunday Service", badge: "~92 MIN · 9 ITEMS",
    items: [
      ["Pre-service loop", 900], ["Walk-in", 300], ["Opener", 270],
      ["Welcome", 120], ["Worship set", 1080], ["Announcements", 180],
      ["Message", 2100], ["Response / Worship", 360], ["Outro", 180],
    ],
  },
  {
    id: "youth", name: "Youth Night", badge: "~72 MIN · 6 ITEMS",
    items: [
      ["Doors / music", 600], ["Hype opener", 300], ["Game segment", 600],
      ["Worship", 720], ["Message", 1200], ["Hang time", 900],
    ],
  },
  {
    id: "special", name: "Special Event", badge: "~73 MIN · 7 ITEMS",
    items: [
      ["Walk-in", 600], ["Welcome", 180], ["Segment A", 900],
      ["Segment B", 900], ["Intermission", 600], ["Segment C", 900], ["Close", 300],
    ],
  },
  { id: "blank", name: "Start Blank", badge: "YOUR CALL", items: [] },
];

const ROLES = [
  { id: "td", label: "Technical Director", desc: "Runs the booth", Icon: Headset, lands: "/show" },
  { id: "pm", label: "Production Manager", desc: "Plans & coordinates", Icon: ClipboardList, lands: "/dashboard/prod-manager" },
  { id: "sm", label: "Stage Manager", desc: "Calls the show", Icon: Timer, lands: "/rundown" },
  { id: "cd", label: "Creative / Worship Dir.", desc: "Owns the content", Icon: Palette, lands: "/streaming/graphics" },
  { id: "pastor", label: "Pastor / Staff", desc: "Oversees everything", Icon: Building2, lands: "/dashboard/prod-manager" },
  { id: "op", label: "Operator / Volunteer", desc: "Runs a position", Icon: SlidersHorizontal, lands: "/show" },
];

const DEPTS = [
  { id: "leadership", label: "Leadership", color: "#FF8A4C", roles: ["media pastor", "lead pastor", "executive pastor", "technical director"], pat: ["director", "pastor"] },
  { id: "production", label: "Production", color: "#F5A623", roles: ["stage manager", "stage hand", "show caller", "production manager", "floor manager"], pat: ["producer", "production"] },
  { id: "camera", label: "Camera", color: "#B98AF5", roles: ["camera operator", "video switcher", "jib operator", "camera shader"], pat: ["camera"] },
  { id: "audio", label: "Audio", color: "#5AA7F0", roles: ["sound tech", "audio engineer", "foh engineer", "monitor engineer", "broadcast audio", "a1", "a2"], pat: ["audio", "sound", "foh"] },
  { id: "visuals", label: "Visuals", color: "#F06FA7", roles: ["lyrics/slides", "graphics", "propresenter", "media shout"], pat: ["lyrics", "slides", "graphic", "propresenter"] },
  { id: "lighting", label: "Lighting", color: "#F0D35A", roles: ["lighting", "lighting designer", "spot operator"], pat: ["lighting", "spot op"] },
  { id: "streaming", label: "Streaming", color: "#3DD68C", roles: ["stream tech", "broadcast engineer"], pat: ["stream", "broadcast"] },
  { id: "technical", label: "Technical", color: "#54D2E0", roles: ["technical manager", "tech lead"], pat: ["tech manager", "technical"] },
];
function inferDept(pos) {
  const v = pos.toLowerCase().trim();
  if (!v) return null;
  for (const d of DEPTS) if (d.roles.includes(v)) return d;
  for (const d of DEPTS) if (d.pat.some((x) => v.includes(x))) return d;
  return { id: "other", label: "Other", color: "#8B919C" };
}

const fmt = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
const fmtLong = (s) => {
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
};

// Persistent timecode clock — the signature that runs through every scene.
function Timecode() {
  const [now, setNow] = useState(() => new Date());
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    const id = setInterval(() => {
      setNow(new Date());
      setFrame((f) => (f + 1) % 30);
    }, 33);
    return () => clearInterval(id);
  }, []);
  const p = (n) => String(n).padStart(2, "0");
  return (
    <div style={{ fontFamily: FONT_MONO, color: T.amber, fontSize: 13, letterSpacing: "0.14em", display: "flex", alignItems: "center", gap: 8 }}>
      <span style={{ width: 7, height: 7, borderRadius: 99, background: T.amber, boxShadow: `0 0 8px ${T.amber}` }} />
      {p(now.getHours())}:{p(now.getMinutes())}:{p(now.getSeconds())}:{p(frame)}
    </div>
  );
}

function Slate({ scene, title }) {
  return (
    <div style={{ fontFamily: FONT_MONO, fontSize: 11, letterSpacing: "0.22em", color: T.faint, textTransform: "uppercase" }}>
      Setup · Scene {scene}/5 — {title}
    </div>
  );
}

function FakeQR() {
  // Deterministic decorative pattern — stands in for the real org-invite QR.
  const cells = useMemo(() => {
    const out = [];
    for (let y = 0; y < 17; y++) for (let x = 0; x < 17; x++) {
      const corner = (x < 5 && y < 5) || (x > 11 && y < 5) || (x < 5 && y > 11);
      const ring = corner && (x % 16 === 0 || y % 16 === 0 || ((x % 16 === 4 || x === 12) && false));
      const on = corner ? ((x % 4 < 3 && y % 4 < 3) ? (x % 4 !== 1 || y % 4 !== 1) : false)
        : ((x * 7 + y * 13 + ((x * y) % 5)) % 3 === 0);
      if (on) out.push([x, y]);
    }
    return out;
  }, []);
  return (
    <svg viewBox="0 0 17 17" width="148" height="148" style={{ background: "#fff", borderRadius: 10, padding: 8, boxSizing: "border-box" }}>
      {cells.map(([x, y], i) => <rect key={i} x={x} y={y} width="1" height="1" fill="#0A0B0D" />)}
    </svg>
  );
}

export default function OnboardingPrototype() {
  const [scene, setScene] = useState(1);
  const [cut, setCut] = useState(false);          // switcher-cut transition
  const [orgName, setOrgName] = useState("");
  const [slugState, setSlugState] = useState("idle"); // idle | checking | ok
  const [role, setRole] = useState(null);
  const [template, setTemplate] = useState(null);
  const [hoverTpl, setHoverTpl] = useState(null);
  const [builtCount, setBuiltCount] = useState(0);
  const [armed, setArmed] = useState(false);
  const [emails, setEmails] = useState([""]);
  const [crew, setCrew] = useState([{ name: "", pos: "" }]);
  const [onAir, setOnAir] = useState(false);
  const [flash, setFlash] = useState(false);
  const skipRef = useRef(false);

  const slug = orgName.trim().toLowerCase().replace(/[^a-z0-9\s-]/g, "").replace(/\s+/g, "-").slice(0, 40);

  // Simulated debounced slug availability
  useEffect(() => {
    if (slug.length < 3) { setSlugState("idle"); return; }
    setSlugState("checking");
    const id = setTimeout(() => setSlugState("ok"), 450);
    return () => clearTimeout(id);
  }, [slug]);

  const go = (next) => {
    setCut(true);
    setTimeout(() => { setScene(next); setCut(false); }, 220); // broadcast cut, with a breath
  };

  // Scene 4 — cascade build
  const tpl = TEMPLATES.find((t) => t.id === template);
  useEffect(() => {
    if (scene !== 4 || !tpl) return;
    setBuiltCount(0); setArmed(false); skipRef.current = false;
    if (tpl.items.length === 0) { setArmed(true); return; }
    let i = 0;
    const id = setInterval(() => {
      if (skipRef.current) { setBuiltCount(tpl.items.length); setArmed(true); clearInterval(id); return; }
      i += 1; setBuiltCount(i);
      if (i >= tpl.items.length) { clearInterval(id); setTimeout(() => setArmed(true), 650); }
    }, 240);
    return () => clearInterval(id);
  }, [scene, template]);

  const builtTotal = tpl ? tpl.items.slice(0, builtCount).reduce((a, [, d]) => a + d, 0) : 0;
  const landing = ROLES.find((r) => r.id === role)?.lands ?? "/show";

  const goLive = () => {
    setFlash(true); // brief dip to black — the "take"
    setTimeout(() => { setFlash(false); setOnAir(true); }, 260);
  };

  const restart = () => {
    setScene(1); setOrgName(""); setRole(null); setTemplate(null);
    setBuiltCount(0); setArmed(false); setEmails([""]); setOnAir(false);
  };

  return (
    <div style={{ minHeight: "100vh", background: T.stage, color: T.text, fontFamily: FONT_DISPLAY, position: "relative", overflow: "hidden" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Archivo:wght@400;500;600;800&family=JetBrains+Mono:wght@400;600&display=swap');
        * { box-sizing: border-box; }
        @keyframes rise { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }
        @keyframes lowerThird { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
        @keyframes pulse { 0%,100% { box-shadow: 0 0 0 0 rgba(229,72,77,.45);} 50% { box-shadow: 0 0 0 16px rgba(229,72,77,0);} }
        @keyframes powerOn {
          0% { opacity: 0; transform: scale(.85); box-shadow: 0 0 0 rgba(229,72,77,0); }
          55% { opacity: 1; transform: scale(1.04); box-shadow: 0 0 90px rgba(229,72,77,.55); }
          100% { opacity: 1; transform: scale(1); box-shadow: 0 0 36px rgba(229,72,77,.3); }
        }
        @keyframes vignette { from { opacity: 0; } to { opacity: 1; } }
        .powerOn { animation: powerOn .4s ease-out both; }
        .vig { animation: vignette .4s ease-out .15s both; }
        .rise { animation: rise .38s ease-out both; }
        .lt { animation: lowerThird .38s ease-out both; }
        .pulse3 { animation: pulse 2s ease-out 3; }
        .card { transition: transform .15s ease-out, background .15s ease-out, border-color .15s ease-out; }
        .card:hover { transform: translateY(-2px); background: ${T.panelHover}; border-color: #3A3F49; }
        input::placeholder { color: ${T.faint}; }
        button { font-family: inherit; }
        @media (prefers-reduced-motion: reduce) {
          .rise, .lt, .powerOn, .vig { animation: none !important; }
          .pulse3 { animation: none !important; }
          .card, .card:hover { transition: none; transform: none; }
        }
      `}</style>

      {/* Persistent header */}
      <div style={{ position: "absolute", top: 0, left: 0, right: 0, display: "flex", justifyContent: "space-between", alignItems: "center", padding: "18px 24px", zIndex: 5 }}>
        <Timecode />
        <div style={{ display: "flex", gap: 16, alignItems: "center" }}>
          {!onAir && <Slate scene={scene} title={["On the air", "Your role", "Pick a show", "Build", "Crew & go"][scene - 1]} />}
          <button onClick={restart} style={{ fontFamily: FONT_MONO, fontSize: 10, letterSpacing: "0.18em", color: T.faint, background: "none", border: `1px solid ${T.border}`, borderRadius: 6, padding: "5px 10px", cursor: "pointer" }}>RESTART</button>
        </div>
      </div>

      {/* Switcher cut */}
      {cut && <div style={{ position: "absolute", inset: 0, background: "#000", zIndex: 9 }} />}
      {/* ON AIR flash */}
      {flash && <div style={{ position: "absolute", inset: 0, background: "#000", zIndex: 9 }} />}

      <div style={{ maxWidth: 760, margin: "0 auto", padding: "108px 24px 64px" }} onClick={() => { if (scene === 4) skipRef.current = true; }}>

        {/* ── SCENE 1 ───────────────────────────── */}
        {scene === 1 && !onAir && (
          <div className="rise">
            <h1 style={{ fontSize: 40, fontWeight: 800, letterSpacing: "-0.02em", margin: "48px 0 10px" }}>
              Let's get your first show<br />on the air.
            </h1>
            <p style={{ color: T.muted, margin: "0 0 36px", fontSize: 16 }}>Name your organization — everything else takes about four minutes.</p>
            <input
              autoFocus value={orgName} onChange={(e) => setOrgName(e.target.value)}
              placeholder="e.g. Faithfire Church"
              style={{ width: "100%", fontSize: 22, fontWeight: 500, background: T.panel, border: `1px solid ${T.border}`, borderRadius: 12, padding: "18px 20px", color: T.text, outline: "none" }}
            />
            {slug.length >= 3 && (
              <div className="lt" key={slug} style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 14, fontFamily: FONT_MONO, fontSize: 13 }}>
                <span style={{ background: T.panel, border: `1px solid ${T.border}`, borderLeft: `3px solid ${slugState === "ok" ? T.green : T.amber}`, borderRadius: 6, padding: "8px 12px", color: T.muted }}>
                  showpilot.tech/<span style={{ color: T.text }}>{slug}</span>
                </span>
                {slugState === "checking" && <span style={{ color: T.faint }}>checking…</span>}
                {slugState === "ok" && <span style={{ color: T.green, display: "flex", alignItems: "center", gap: 4 }}><Check size={13} /> available</span>}
              </div>
            )}
            <button
              disabled={slugState !== "ok"} onClick={() => go(2)}
              style={{ marginTop: 36, display: "inline-flex", alignItems: "center", gap: 10, fontSize: 16, fontWeight: 600, color: slugState === "ok" ? "#0A0B0D" : T.faint, background: slugState === "ok" ? T.text : T.panel, border: `1px solid ${T.border}`, borderRadius: 10, padding: "14px 22px", cursor: slugState === "ok" ? "pointer" : "default" }}
            >
              Build my show <ArrowRight size={17} />
            </button>
          </div>
        )}

        {/* ── SCENE 2 ───────────────────────────── */}
        {scene === 2 && !onAir && (
          <div className="rise">
            <h1 style={{ fontSize: 32, fontWeight: 800, margin: "40px 0 6px" }}>What's your role on the team?</h1>
            <p style={{ color: T.muted, margin: "0 0 28px" }}>This just sets up your view — you're the owner either way.</p>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))", gap: 12 }}>
              {ROLES.map((r, i) => (
                <button key={r.id} className="card rise" onClick={() => { setRole(r.id); go(3); }}
                  style={{ animationDelay: `${i * 90}ms`, textAlign: "left", background: T.panel, border: `1px solid ${T.border}`, borderRadius: 14, padding: "20px 18px", cursor: "pointer", color: T.text }}>
                  <r.Icon size={22} style={{ color: T.amber, marginBottom: 12 }} />
                  <div style={{ fontWeight: 600, fontSize: 15 }}>{r.label}</div>
                  <div style={{ color: T.muted, fontSize: 13, marginTop: 3 }}>{r.desc}</div>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* ── SCENE 3 ───────────────────────────── */}
        {scene === 3 && !onAir && (
          <div className="rise">
            <h1 style={{ fontSize: 32, fontWeight: 800, margin: "40px 0 6px" }}>Pick your first show.</h1>
            <p style={{ color: T.muted, margin: "0 0 28px" }}>Hover a card to preview its rundown. You can change everything later.</p>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(250px, 1fr))", gap: 14 }}>
              {TEMPLATES.map((t, i) => {
                const open = hoverTpl === t.id && t.items.length > 0;
                return (
                  <button key={t.id} className="card rise" onMouseEnter={() => setHoverTpl(t.id)} onMouseLeave={() => setHoverTpl(null)}
                    onClick={() => { setTemplate(t.id); go(4); }}
                    style={{ animationDelay: `${i * 90}ms`, textAlign: "left", background: `linear-gradient(160deg, ${T.panelHover}, ${T.panel} 60%)`, border: `1px solid ${T.border}`, borderRadius: 16, padding: 20, cursor: "pointer", color: T.text }}>
                    <div style={{ fontFamily: FONT_MONO, fontSize: 10, letterSpacing: "0.2em", color: T.amber }}>{t.badge}</div>
                    <div style={{ fontSize: 21, fontWeight: 800, margin: "8px 0 4px", letterSpacing: "-0.01em" }}>{t.name}</div>
                    {open && (
                      <div style={{ marginTop: 12, borderTop: `1px solid ${T.border}`, paddingTop: 10 }}>
                        {t.items.slice(0, 5).map(([name, dur], j) => (
                          <div key={name} className="rise" style={{ animationDelay: `${j * 40}ms`, display: "flex", justifyContent: "space-between", fontFamily: FONT_MONO, fontSize: 12, color: T.muted, padding: "3px 0" }}>
                            <span>{name}</span><span>{fmt(dur)}</span>
                          </div>
                        ))}
                        {t.items.length > 5 && <div style={{ fontFamily: FONT_MONO, fontSize: 11, color: T.faint, paddingTop: 4 }}>+{t.items.length - 5} more…</div>}
                      </div>
                    )}
                    {!open && t.items.length > 0 && <div style={{ color: T.faint, fontSize: 13, marginTop: 6, display: "flex", alignItems: "center", gap: 4 }}>Preview rundown <ChevronRight size={13} /></div>}
                    {t.items.length === 0 && <div style={{ color: T.faint, fontSize: 13, marginTop: 6 }}>Empty stage. Build it your way.</div>}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* ── SCENE 4 ───────────────────────────── */}
        {scene === 4 && !onAir && tpl && (
          <div className="rise">
            <h1 style={{ fontSize: 28, fontWeight: 800, margin: "36px 0 20px" }}>
              {tpl.items.length ? (armed ? "Your show is built." : "Building your show…") : "The stage is yours."}
            </h1>
            {tpl.items.length > 0 && (
              <div style={{ background: T.panel, border: `1px solid ${T.border}`, borderRadius: 14, overflow: "hidden" }}>
                {tpl.items.slice(0, builtCount).map(([name, dur], i) => (
                  <div key={name} className="rise" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "11px 18px", borderBottom: `1px solid ${T.border}` }}>
                    <span style={{ display: "flex", gap: 14, alignItems: "baseline" }}>
                      <span style={{ fontFamily: FONT_MONO, fontSize: 11, color: T.faint }}>{String(i + 1).padStart(2, "0")}</span>
                      <span style={{ fontWeight: 500, fontSize: 15 }}>{name}</span>
                    </span>
                    <span style={{ fontFamily: FONT_MONO, fontSize: 13, color: T.muted }}>{fmt(dur)}</span>
                  </div>
                ))}
                <div style={{ display: "flex", justifyContent: "space-between", padding: "13px 18px", fontFamily: FONT_MONO, fontSize: 13 }}>
                  <span style={{ color: T.faint, letterSpacing: "0.15em" }}>TOTAL RUNTIME</span>
                  <span style={{ color: armed ? T.green : T.amber }}>{fmtLong(builtTotal)}</span>
                </div>
              </div>
            )}
            {armed && (
              <div className="rise" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 22 }}>
                <div className="rise" style={{ fontFamily: FONT_MONO, fontSize: 12, letterSpacing: "0.2em", color: T.green, display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ width: 7, height: 7, borderRadius: 99, background: T.green }} /> SHOW CLOCK ARMED
                </div>
                <button onClick={() => go(5)} style={{ display: "inline-flex", alignItems: "center", gap: 10, fontSize: 16, fontWeight: 600, color: "#0A0B0D", background: T.text, border: "none", borderRadius: 10, padding: "13px 20px", cursor: "pointer" }}>
                  Get your team in <ArrowRight size={17} />
                </button>
              </div>
            )}
            {!armed && tpl.items.length > 0 && <p style={{ color: T.faint, fontSize: 12, fontFamily: FONT_MONO, marginTop: 14 }}>click anywhere to skip</p>}
          </div>
        )}

        {/* ── SCENE 5 ───────────────────────────── */}
        {scene === 5 && !onAir && (
          <div className="rise">
            <h1 style={{ fontSize: 30, fontWeight: 800, margin: "36px 0 6px" }}>Build your team.</h1>
            <p style={{ color: T.muted, margin: "0 0 26px" }}>Two kinds of people run a show — both optional for now.</p>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", gap: 14 }}>

              {/* Crew — show board only, no accounts */}
              <div style={{ background: T.panel, border: `1px solid ${T.border}`, borderRadius: 14, padding: 22 }}>
                <div style={{ fontFamily: FONT_MONO, fontSize: 10, letterSpacing: "0.2em", color: T.amber, marginBottom: 4 }}>SHOW BOARD</div>
                <div style={{ fontWeight: 700, fontSize: 16 }}>Add your crew</div>
                <p style={{ color: T.muted, fontSize: 13, margin: "4px 0 14px" }}>
                  Operators who appear on the board and check in on show day — no account, no login.
                </p>
                {crew.map((c, i) => {
                  const dept = inferDept(c.pos);
                  return (
                    <div key={i} style={{ marginBottom: 10 }}>
                      <div style={{ display: "flex", gap: 8 }}>
                        <input value={c.name} onChange={(e) => setCrew(crew.map((v, j) => j === i ? { ...v, name: e.target.value } : v))}
                          placeholder="Name"
                          style={{ flex: 1.2, background: T.stage, border: `1px solid ${T.border}`, borderRadius: 8, padding: "10px 12px", color: T.text, fontSize: 14, outline: "none" }} />
                        <input value={c.pos} onChange={(e) => setCrew(crew.map((v, j) => j === i ? { ...v, pos: e.target.value } : v))}
                          placeholder="Position (e.g. Camera 2, A1)"
                          style={{ flex: 1.4, background: T.stage, border: `1px solid ${T.border}`, borderRadius: 8, padding: "10px 12px", color: T.text, fontSize: 14, outline: "none" }} />
                      </div>
                      {dept && (
                        <div className="lt" key={dept.id} style={{ display: "inline-flex", alignItems: "center", gap: 6, marginTop: 6, fontFamily: FONT_MONO, fontSize: 10, letterSpacing: "0.14em", textTransform: "uppercase", color: dept.color, border: `1px solid ${dept.color}40`, background: `${dept.color}14`, borderRadius: 99, padding: "3px 10px" }}>
                          <span style={{ width: 5, height: 5, borderRadius: 99, background: dept.color }} />
                          {dept.label}
                        </div>
                      )}
                    </div>
                  );
                })}
                {crew.length < 4 && (
                  <button onClick={() => setCrew([...crew, { name: "", pos: "" }])} style={{ display: "flex", alignItems: "center", gap: 6, background: "none", border: "none", color: T.faint, fontSize: 13, cursor: "pointer", padding: 0 }}>
                    <Plus size={14} /> Add another
                  </button>
                )}
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 14, paddingTop: 12, borderTop: `1px solid ${T.border}`, color: T.faint, fontSize: 12 }}>
                  <QrCode size={14} style={{ color: T.amber, flexShrink: 0 }} />
                  On show day, your board shows a "Scan to Serve" code — crew check in from their phones.
                </div>
              </div>

              {/* App members — accounts with roles */}
              <div style={{ background: T.panel, border: `1px solid ${T.border}`, borderRadius: 14, padding: 22 }}>
                <div style={{ fontFamily: FONT_MONO, fontSize: 10, letterSpacing: "0.2em", color: T.green, marginBottom: 4 }}>APP ACCESS</div>
                <div style={{ fontWeight: 700, fontSize: 16 }}>Invite your leads</div>
                <p style={{ color: T.muted, fontSize: 13, margin: "4px 0 14px" }}>
                  People who log in to run rundowns, devices, and dashboards.
                </p>
                {emails.map((em, i) => (
                  <div key={i} style={{ display: "flex", gap: 8, marginBottom: 10 }}>
                    <input value={em} onChange={(e) => setEmails(emails.map((v, j) => j === i ? e.target.value : v))}
                      placeholder="name@church.org"
                      style={{ flex: 1, background: T.stage, border: `1px solid ${T.border}`, borderRadius: 8, padding: "10px 12px", color: T.text, fontSize: 14, outline: "none" }} />
                    <select style={{ background: T.stage, border: `1px solid ${T.border}`, borderRadius: 8, color: T.muted, fontSize: 13, padding: "0 8px" }}>
                      <option>Member</option><option>Technical Director</option><option>Creative Director</option><option>Production Director</option><option>Production Manager</option><option>Technical Manager</option><option>Stage Manager</option><option>Admin</option>
                    </select>
                  </div>
                ))}
                {emails.length < 3 && (
                  <button onClick={() => setEmails([...emails, ""])} style={{ display: "flex", alignItems: "center", gap: 6, background: "none", border: "none", color: T.faint, fontSize: 13, cursor: "pointer", padding: 0 }}>
                    <Plus size={14} /> Add another
                  </button>
                )}
              </div>
            </div>
            <div style={{ display: "grid", placeItems: "center", marginTop: 44 }}>
              <button onClick={goLive} className="pulse3"
                style={{ width: 130, height: 130, borderRadius: 999, background: `radial-gradient(circle at 35% 30%, #FF6A6E, ${T.red} 65%)`, border: `1px solid #FF7A7E`, color: "#fff", fontFamily: FONT_MONO, fontWeight: 600, fontSize: 17, letterSpacing: "0.18em", cursor: "pointer" }}>
                GO<br />LIVE
              </button>
              <div style={{ fontFamily: FONT_MONO, fontSize: 11, letterSpacing: "0.2em", color: T.faint, marginTop: 14 }}>TAKE YOUR SHOW TO AIR</div>
            </div>
          </div>
        )}

        {/* ── END CARD ──────────────────────────── */}
        {onAir && (
          <div style={{ textAlign: "center", paddingTop: 70, position: "relative" }}>
            <div className="vig" style={{ position: "fixed", inset: 0, pointerEvents: "none", background: "radial-gradient(ellipse 70% 45% at 50% 18%, rgba(229,72,77,.13), transparent 70%)" }} />
            <div className="powerOn" style={{ display: "inline-flex", alignItems: "center", gap: 12, fontFamily: FONT_MONO, fontSize: 26, fontWeight: 600, letterSpacing: "0.3em", color: "#fff", background: T.red, borderRadius: 14, padding: "16px 34px" }}>
              <span style={{ width: 10, height: 10, borderRadius: 99, background: "#fff" }} /> ON AIR
            </div>
            <h1 className="rise" style={{ animationDelay: "200ms", fontSize: 34, fontWeight: 800, margin: "30px 0 10px" }}>{orgName || "Your org"} is live on ShowPilot.</h1>
            <p className="rise" style={{ animationDelay: "340ms", color: T.muted, fontSize: 15 }}>
              In the real app, you'd now land on <span style={{ fontFamily: FONT_MONO, color: T.amber }}>/{slug || "your-org"}{landing}</span> — chosen by your role —<br />
              with the seeded rundown and a first-session checklist waiting.
            </p>
            <button className="rise" onClick={restart} style={{ animationDelay: "480ms", marginTop: 28, fontSize: 15, fontWeight: 600, color: T.text, background: T.panel, border: `1px solid ${T.border}`, borderRadius: 10, padding: "12px 20px", cursor: "pointer" }}>
              Run it again
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
