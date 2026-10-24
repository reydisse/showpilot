import { useState, type CSSProperties, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import type { SignInDesign } from "@/lib/signin-design";
import "./signin.css";

const COPY = {
  rhythm: {
    number: "01",
    overline: "LESS FRICTION. MORE FLOW.",
    title: (
      <>
        Every cue.
        <br />A little more in sync.
      </>
    ),
    description: (
      <>
        A calm place to bring your next
        <br />
        great moment together.
      </>
    ),
  },
  afterglow: {
    number: "02",
    overline: "THE MOMENT BEFORE THE MOMENT.",
    title: (
      <>
        Make room
        <br />
        for a great show.
      </>
    ),
    description: (
      <>
        Everything you need, quietly in place.
        <br />
        Now let’s bring it to life.
      </>
    ),
  },
  "in-sync": {
    number: "03",
    overline: "GOOD SHOWS START TOGETHER.",
    title: (
      <>
        Everyone ready.
        <br />
        Everything in reach.
      </>
    ),
    description: (
      <>
        From the first cue to the final moment.
        <br />
        Keep your whole team connected.
      </>
    ),
  },
};

export function SignInShell({
  initialDesign,
  children,
}: {
  initialDesign: SignInDesign;
  children: ReactNode;
}) {
  // Keep the chosen artwork still even if a session refresh crosses a month boundary.
  const [design] = useState(initialDesign);
  const [paused, setPaused] = useState(false);
  const copy = COPY[design];
  return (
    <main
      className={`signin-shell${paused ? " paused" : ""}`}
      data-design={design}
    >
      <section className="entry">
        <Link className="wordmark" to="/login" aria-label="ShowPilot">
          <img src="/showpilot-logo.svg" alt="" width={29} height={29} />
          <span>
            <b>Show</b>Pilot
          </span>
        </Link>
        <div className="form-wrap">{children}</div>
        <footer className="foot">
          <span>Made for the people behind the show.</span>
          <div>
            <button
              type="button"
              className="mobile-motion-control"
              onClick={() => setPaused(!paused)}
              aria-pressed={paused}
            >
              {paused ? "Resume motion" : "Pause motion"}
            </button>
            <Link to="/privacy">Privacy</Link>
            <Link to="/terms">Terms</Link>
          </div>
        </footer>
      </section>
      <aside className="art" aria-label="ShowPilot artwork">
        <div className="art-top" aria-hidden="true">
          <span className="tiny-icon">✳</span>
          <span>BEHIND EVERY GREAT MOMENT</span>
          <span className="edition">SP / {copy.number}</span>
        </div>
        <div className="artwork" aria-hidden="true">
          {design === "rhythm" && (
            <>
              <div className="tiles">
                {Array.from({ length: 20 }, (_, i) => {
                  const tileStyle: CSSProperties & { "--i": number } = {
                    "--i": i,
                  };
                  return (
                    <div className="tile" key={i} style={tileStyle}>
                      <i />
                    </div>
                  );
                })}
              </div>
              <div className="rhythm-fade" />
            </>
          )}
          {design === "afterglow" && (
            <>
              <div className="halo" />
              <div className="orbital">
                <i />
                <i />
                <i />
                <i />
                <i />
                <div className="center-point" />
              </div>
              <div className="floor" />
              <span className="coord">35° / READY WHEN YOU ARE</span>
            </>
          )}
          {design === "in-sync" && (
            <>
              <div className="tracks">
                {["PRE-SHOW", "WELCOME", "THE MOMENT", "WHAT'S NEXT"].map(
                  (label, i) => (
                    <div
                      className={`track${i === 2 ? " current" : ""}`}
                      key={label}
                    >
                      <span>0{i + 1}</span>
                      <i />
                      <small>{label}</small>
                    </div>
                  ),
                )}
              </div>
              <div className="cue-card">
                <div className="cue-head">
                  <span className="cue-dot" /> ALL TOGETHER <span>↗</span>
                </div>
                <div className="cue-title">
                  One team.
                  <br />
                  In perfect time.
                </div>
                <div className="cue-line">
                  <i />
                </div>
                <div className="cue-bottom">
                  <span>STAGE · SOUND · VISION</span>
                  <span>SHOWPILOT</span>
                </div>
              </div>
            </>
          )}
        </div>
        <div className="art-copy">
          <span className="overline">{copy.overline}</span>
          <h2>{copy.title}</h2>
          <p>{copy.description}</p>
          <div className="art-bottom">
            <span>LIVE PRODUCTION, CONNECTED.</span>
            <button
              type="button"
              onClick={() => setPaused(!paused)}
              aria-pressed={paused}
              className="motion-control"
            >
              {paused ? "Resume motion" : "Pause motion"}
            </button>
          </div>
        </div>
      </aside>
    </main>
  );
}
