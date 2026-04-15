import { useState, useEffect, useRef } from "react";

// ─────────────────────────────────────────────────────────────
//  COLLAB//MIX  —  Production Landing Page
//  Clean React, no smart quotes, responsive, scroll nav
// ─────────────────────────────────────────────────────────────

const C = {
  gold:   "#C8A96E",
  gold2:  "#E8C98A",
  dark:   "#080710",
  dark2:  "#0E0C1A",
  indigo: "#1C1830",
  muted:  "#3A3555",
  text:   "#EDE8DF",
  subtle: "#7A7090",
};

// ── Breathing waveform canvas ─────────────────────────────────
function Waveform({ width = 600, height = 72, opacity = 0.6, speed = 1 }) {
  const ref   = useRef(null);
  const frame = useRef(0);
  const raf   = useRef(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    const W   = canvas.width;

    const env = Array.from({ length: W }, (_, i) => {
      const x = i / W;
      return Math.max(0.04, Math.min(0.96,
        Math.abs(Math.sin(x * Math.PI * 8)        * 0.38) +
        Math.abs(Math.sin(x * Math.PI * 3.7 + 1.2) * 0.24) +
        Math.abs(Math.sin(x * Math.PI * 17 + 0.4)  * 0.14) + 0.05
      ));
    });

    const draw = () => {
      frame.current += 0.012 * speed;
      ctx.clearRect(0, 0, W, height);
      const head = ((frame.current * 0.15) % 1) * W;

      for (let x = 0; x < W; x++) {
        const b = 1 + Math.sin(frame.current * 2 + x * 0.02) * 0.06;
        const h = env[x] * height * 0.9 * b;
        const y = (height - h) / 2;

        if (Math.abs(x - head) < 2) {
          ctx.fillStyle = "#ffffff";
          ctx.shadowColor = "#ffffff";
          ctx.shadowBlur  = 8;
        } else if (x < head) {
          const w = x / W;
          ctx.fillStyle = `rgba(${Math.round(200 + w*30)},${Math.round(169 + w*20)},${Math.round(110 - w*20)},${opacity})`;
          ctx.shadowBlur = 0;
        } else {
          ctx.fillStyle = `rgba(200,169,110,${opacity * 0.22})`;
          ctx.shadowBlur = 0;
        }
        ctx.fillRect(x, y, 1, Math.max(1, h));
      }
      ctx.shadowBlur = 0;
      raf.current = requestAnimationFrame(draw);
    };

    draw();
    return () => cancelAnimationFrame(raf.current);
  }, [opacity, speed, height]);

  return (
    <canvas
      ref={ref}
      width={width}
      height={height}
      style={{ width: "100%", height, display: "block", borderRadius: 4 }}
    />
  );
}

// ── Scrolling ticker ─────────────────────────────────────────
function Ticker() {
  const items = [
    "Dual Deck Mixing", "Real-Time Sync", "BPM Detection",
    "MIDI Controllers", "P2P Audio", "Session Recording",
    "DJ Matchmaking", "Music Profiles", "Global Community", "Free to Join",
  ];
  const doubled = [...items, ...items];

  return (
    <div style={{ overflow: "hidden", borderTop: `1px solid ${C.gold}18`, borderBottom: `1px solid ${C.gold}18`, padding: "12px 0", background: C.dark2 }}>
      <div style={{ display: "flex", gap: 56, animation: "ticker 30s linear infinite", whiteSpace: "nowrap" }}>
        {doubled.map((item, i) => (
          <span key={i} style={{ fontSize: 10, fontFamily: "'DM Mono', monospace", color: C.muted, letterSpacing: 3, flexShrink: 0, textTransform: "uppercase" }}>
            {item}
            <span style={{ color: `${C.gold}30`, margin: "0 16px" }}>{"◇"}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

// ── App preview (decorative) ─────────────────────────────────
function AppPreview() {
  const decks = [
    { color: C.gold,    label: "A", bpm: "124.0", playing: true  },
    { color: "#8B6EAF", label: "B", bpm: "122.5", playing: false },
  ];

  return (
    <div style={{ background: `linear-gradient(145deg,${C.dark2},${C.dark})`, border: `1px solid ${C.gold}18`, borderRadius: 16, padding: 20, boxShadow: `0 0 0 1px ${C.indigo},0 40px 80px rgba(0,0,0,.7)`, position: "relative", overflow: "hidden" }}>
      <div style={{ position: "absolute", top: -60, right: -60, width: 180, height: 180, borderRadius: "50%", background: `radial-gradient(circle,${C.gold}0a,transparent 70%)`, pointerEvents: "none" }} />

      {/* Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16, paddingBottom: 12, borderBottom: `1px solid ${C.gold}10` }}>
        <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 8, color: C.gold, letterSpacing: 3 }}>COLLAB//MIX</span>
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <div style={{ width: 5, height: 5, borderRadius: "50%", background: "#22c55e", boxShadow: "0 0 6px #22c55e" }} />
          <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 7, color: C.subtle, letterSpacing: 2 }}>SESSION LIVE</span>
        </div>
      </div>

      {/* Decks */}
      {decks.map((deck) => (
        <div key={deck.label} style={{ background: C.dark, borderRadius: 8, padding: "12px 14px", marginBottom: 8, border: `1px solid ${deck.color}18` }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 7, color: deck.color, letterSpacing: 2 }}>
                DECK {deck.label}
              </span>
              {deck.playing && (
                <div style={{ width: 4, height: 4, borderRadius: "50%", background: deck.color, animation: "blink 1.2s ease-in-out infinite" }} />
              )}
            </div>
            <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 8, color: C.subtle }}>{deck.bpm} BPM</span>
          </div>
          <div style={{ marginBottom: 8, background: "#04030a", borderRadius: 4, overflow: "hidden" }}>
            <Waveform width={500} height={32} opacity={deck.playing ? 0.75 : 0.4} speed={deck.playing ? 1 : 0.6} />
          </div>
          <div style={{ display: "flex", gap: 3, justifyContent: "center" }}>
            {["⏮", "◂◂", deck.playing ? "⏸" : "▶", "▸▸"].map((btn) => (
              <div key={btn} style={{ width: 22, height: 18, background: C.dark2, border: `1px solid ${(btn === "⏸" || btn === "▶") ? `${deck.color}44` : `${C.muted}22`}`, borderRadius: 3, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 7, color: (btn === "⏸" || btn === "▶") ? deck.color : C.muted }}>{btn}</div>
            ))}
          </div>
        </div>
      ))}

      {/* Crossfader */}
      <div style={{ padding: "10px 0 4px" }}>
        <div style={{ height: 3, background: `linear-gradient(90deg,${C.gold}88 55%,#8B6EAF44 55%)`, borderRadius: 2, position: "relative", marginBottom: 6 }}>
          <div style={{ position: "absolute", left: "calc(52% - 8px)", top: -5, width: 16, height: 13, background: "#e8e2d9", borderRadius: 3, boxShadow: "0 2px 8px rgba(0,0,0,.5)" }} />
        </div>
        <div style={{ display: "flex", justifyContent: "space-between" }}>
          <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 7, color: `${C.gold}88` }}>A 53%</span>
          <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 7, color: `${C.subtle}55`, letterSpacing: 2 }}>XFADER</span>
          <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 7, color: "#8B6EAF88" }}>47% B</span>
        </div>
      </div>
    </div>
  );
}

// ── Lobby preview card ────────────────────────────────────────
function LobbyCard({ name, location, genres, bpm, status }) {
  const statusColor = status === "playing" ? "#22c55e" : C.gold;
  const statusLabel = status === "playing" ? "In Session" : "Looking to Play";

  return (
    <div style={{ background: C.dark2, border: `1px solid ${C.gold}14`, borderRadius: 10, padding: "14px 16px", display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
        <div>
          <div style={{ fontFamily: "'Cormorant Garamond', serif", fontSize: 16, fontWeight: 700, color: C.text }}>{name}</div>
          <div style={{ fontFamily: "'DM Mono', monospace", fontSize: 8, color: C.subtle, letterSpacing: 1, marginTop: 2 }}>{location}</div>
        </div>
        <div style={{ display: "flex", gap: 5, alignItems: "center" }}>
          <div style={{ width: 5, height: 5, borderRadius: "50%", background: statusColor, boxShadow: `0 0 6px ${statusColor}` }} />
          <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 7, color: statusColor, letterSpacing: 1 }}>{statusLabel}</span>
        </div>
      </div>
      <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
        {genres.map((g) => (
          <span key={g} style={{ fontFamily: "'DM Mono', monospace", fontSize: 7, color: C.gold, background: `${C.gold}12`, border: `1px solid ${C.gold}20`, borderRadius: 10, padding: "2px 8px", letterSpacing: 1 }}>{g}</span>
        ))}
      </div>
      <div style={{ fontFamily: "'DM Mono', monospace", fontSize: 8, color: C.muted }}>{bpm} BPM</div>
    </div>
  );
}

// ── Shared component: eyebrow label ──────────────────────────
function Eyebrow({ children }) {
  return (
    <div style={{ fontFamily: "'DM Mono', monospace", fontSize: 9, color: C.gold, letterSpacing: 4, marginBottom: 20, display: "flex", alignItems: "center", gap: 10 }}>
      <div style={{ width: 20, height: 1, background: C.gold }} />
      {children}
    </div>
  );
}

// ── Shared component: step ────────────────────────────────────
function Step({ n, title, body, last }) {
  return (
    <div style={{ display: "flex", gap: 24, alignItems: "flex-start" }}>
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", flexShrink: 0 }}>
        <div style={{ width: 36, height: 36, borderRadius: "50%", border: `1px solid ${C.gold}44`, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "'DM Mono', monospace", fontSize: 11, color: C.gold }}>{n}</div>
        {!last && <div style={{ width: 1, height: 48, background: `linear-gradient(${C.gold}22,transparent)`, marginTop: 8 }} />}
      </div>
      <div style={{ paddingTop: 6, paddingBottom: last ? 0 : 48 }}>
        <div style={{ fontFamily: "'Cormorant Garamond', serif", fontSize: 20, fontWeight: 700, color: C.text, marginBottom: 6, letterSpacing: -0.2 }}>{title}</div>
        <div style={{ fontFamily: "'DM Sans', sans-serif", fontSize: 13, color: C.subtle, lineHeight: 1.7, fontWeight: 300 }}>{body}</div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
//  MAIN LANDING PAGE
// ─────────────────────────────────────────────────────────────
export default function Landing({ onLaunch = () => {} }) {
  const [navSolid, setNavSolid] = useState(false);
  const [djName, setDjName] = useState("");
  const isJoining = typeof window !== "undefined" && new URLSearchParams(window.location.search).has("room");
  const containerRef = useRef(null);

  const handleLaunch = () => onLaunch(djName.trim() || null);

  // Section refs for smooth scroll
  const featuresRef   = useRef(null);
  const howRef        = useRef(null);
  const communityRef  = useRef(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const fn = () => setNavSolid(el.scrollTop > 60);
    el.addEventListener("scroll", fn, { passive: true });
    return () => el.removeEventListener("scroll", fn);
  }, []);

  const scrollTo = (ref) => {
    ref.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  const lobbyCards = [
    { name: "DJ Apex",   location: "Seattle, WA",    genres: ["Progressive House", "Melodic"],  bpm: "122-128", status: "looking" },
    { name: "Nova",      location: "Berlin, DE",     genres: ["Techno", "Melodic Techno"],       bpm: "130-140", status: "playing" },
    { name: "Flux",      location: "London, UK",     genres: ["Deep House", "Organic"],          bpm: "118-124", status: "looking" },
    { name: "Orbit",     location: "Melbourne, AU",  genres: ["Progressive", "Anjunadeep"],      bpm: "124-130", status: "looking" },
  ];

  const features = [
    { n: "01", title: "Real-Time State Sync",            body: "Every crossfader move, EQ adjustment, and transport control reaches your partner instantly. The session feels like you are in the same room." },
    { n: "02", title: "Your decks. Their ears.",          body: "WebRTC streams your live mix directly to your partner peer to peer. They hear every fade, every filter, every moment you make." },
    { n: "03", title: "The beat does not care where you are.", body: "Automatic BPM detection on every track. Beat grid overlaid on the waveform. One tap locks both decks to the same grid." },
    { n: "04", title: "MIDI Controllers",                body: "Connect any DDJ, CDJ, or MIDI device. One-click learn mode maps every knob, fader, and button in seconds." },
    { n: "05", title: "Capture the session.",            body: "Everything you play together can be recorded and downloaded. The set that should not have been possible -- now you have proof it happened." },
    { n: "06", title: "3-Band EQ per Deck",              body: "High shelf, peaking mid, low shelf -- real BiquadFilter nodes inside the Web Audio graph. Not a simulation. A proper signal chain." },
  ];

  // Shared button styles
  const btnGold = {
    padding: "14px 36px", background: C.gold, border: "none",
    color: C.dark, fontFamily: "'DM Mono', monospace", fontWeight: 500,
    fontSize: 11, letterSpacing: 2, borderRadius: 8, cursor: "pointer",
    boxShadow: `0 0 32px ${C.gold}30,0 8px 20px rgba(0,0,0,.4)`,
    transition: "all .2s ease",
  };
  const btnGhost = {
    padding: "14px 28px", background: "transparent",
    border: `1px solid ${C.gold}28`, color: C.subtle,
    fontFamily: "'DM Mono', monospace", fontSize: 10,
    letterSpacing: 2, borderRadius: 8, cursor: "pointer",
    transition: "all .2s ease",
  };

  return (
    <div
      ref={containerRef}
      style={{ height: "100vh", overflowY: "auto", background: C.dark, color: C.text, fontFamily: "'DM Sans', sans-serif", scrollBehavior: "smooth" }}
    >
      <style>{`
        @keyframes blink     { 0%,100%{opacity:1}  50%{opacity:.35} }
        @keyframes ticker    { from{transform:translateX(0)} to{transform:translateX(-50%)} }
        @keyframes fadeUp    { from{opacity:0;transform:translateY(24px)} to{opacity:1;transform:translateY(0)} }
        @keyframes fadeUpD   { from{opacity:0;transform:translateY(24px)} to{opacity:1;transform:translateY(0)} }
        @keyframes drift     { 0%,100%{transform:translateY(0) scale(1)} 50%{transform:translateY(-16px) scale(1.02)} }
        @keyframes glow      { 0%,100%{opacity:.35} 50%{opacity:.75} }

        * { box-sizing: border-box; margin: 0; padding: 0; }

        /* Scrollbar */
        ::-webkit-scrollbar       { width: 3px; }
        ::-webkit-scrollbar-track { background: ${C.dark}; }
        ::-webkit-scrollbar-thumb { background: ${C.indigo}; border-radius: 2px; }

        /* Nav hover */
        .nav-link:hover { color: ${C.gold} !important; }
        .nav-link       { transition: color .2s !important; cursor: pointer; }

        /* Button hovers */
        .btn-gold:hover  { background: ${C.gold2} !important; transform: translateY(-1px) !important; box-shadow: 0 0 44px ${C.gold}55, 0 8px 24px rgba(0,0,0,.5) !important; }
        .btn-ghost:hover { background: ${C.gold}14 !important; border-color: ${C.gold}55 !important; color: ${C.gold} !important; }

        /* Feature card hover */
        .feat-card:hover { border-color: ${C.gold}30 !important; background: linear-gradient(145deg,${C.indigo}80,${C.dark2}80) !important; transform: translateY(-3px) !important; box-shadow: 0 16px 40px rgba(0,0,0,.4) !important; }
        .feat-card       { transition: all .3s ease !important; }

        /* Lobby card hover */
        .lobby-card:hover { border-color: ${C.gold}30 !important; background: ${C.indigo} !important; }
        .lobby-card       { transition: all .25s ease !important; cursor: pointer; }

        /* Quote row hover */
        .quote-row:hover p { color: ${C.text} !important; }
        .quote-row p       { transition: color .25s !important; }

        /* Spec row hover */
        .spec-row:hover { background: ${C.gold}06 !important; }
        .spec-row       { transition: background .15s !important; }

        /* Responsive */
        @media (max-width: 900px) {
          .hero-grid    { grid-template-columns: 1fr !important; }
          .hero-preview { display: none !important; }
          .feat-grid    { grid-template-columns: 1fr 1fr !important; }
          .how-grid     { grid-template-columns: 1fr !important; }
          .quote-grid   { padding: 60px 24px !important; }
          .lobby-grid   { grid-template-columns: 1fr 1fr !important; }
          .stats-row    { gap: 24px !important; flex-wrap: wrap !important; }
          .section-pad  { padding: 60px 24px !important; }
          .nav-links    { display: none !important; }
        }
        @media (max-width: 600px) {
          .feat-grid  { grid-template-columns: 1fr !important; }
          .lobby-grid { grid-template-columns: 1fr !important; }
          h1          { font-size: 48px !important; }
        }
      `}</style>
      <link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,600;0,700;1,600;1,700&family=DM+Sans:wght@300;400;500&family=DM+Mono:wght@400;500&display=swap" rel="stylesheet" />

      {/* ── NAV ── */}
      <nav style={{ position: "sticky", top: 0, zIndex: 100, padding: "0 48px", height: 64, display: "flex", justifyContent: "space-between", alignItems: "center", background: navSolid ? `${C.dark}f2` : "transparent", backdropFilter: navSolid ? "blur(24px)" : "none", borderBottom: navSolid ? `1px solid ${C.gold}12` : "1px solid transparent", transition: "all .4s ease" }}>

        {/* Logo */}
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{ width: 30, height: 30, borderRadius: 8, border: `1px solid ${C.gold}38`, display: "flex", alignItems: "center", justifyContent: "center", background: `${C.gold}08` }}>
            <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 10, color: C.gold }}>{"//"}</span>
          </div>
          <span style={{ fontFamily: "'Cormorant Garamond', serif", fontSize: 20, fontWeight: 700, color: C.text, letterSpacing: -0.3 }}>
            {"Collab"}
            <span style={{ color: C.gold }}>{"//"}</span>
            {"Mix"}
          </span>
        </div>

        {/* Nav links */}
        <div className="nav-links" style={{ display: "flex", gap: 36, alignItems: "center" }}>
          <span className="nav-link" style={{ fontSize: 13, color: C.subtle }} onClick={() => scrollTo(featuresRef)}>Features</span>
          <span className="nav-link" style={{ fontSize: 13, color: C.subtle }} onClick={() => scrollTo(communityRef)}>Community</span>
          <span className="nav-link" style={{ fontSize: 13, color: C.subtle }} onClick={() => scrollTo(howRef)}>How It Works</span>
          <button onClick={handleLaunch} className="btn-gold" style={{ ...btnGold, padding: "9px 22px", fontSize: 10 }}>
            OPEN THE ROOM
          </button>
        </div>
      </nav>

      {/* ── HERO ── */}
      <section className="section-pad" style={{ minHeight: "92vh", display: "flex", flexDirection: "column", justifyContent: "center", padding: "60px 48px 40px", position: "relative", overflow: "hidden" }}>

        {/* Ambient glows */}
        <div style={{ position: "absolute", inset: 0, pointerEvents: "none" }}>
          <div style={{ position: "absolute", top: "5%", right: "-5%", width: "55%", height: "70%", borderRadius: "50%", background: `radial-gradient(ellipse,${C.gold}07 0%,transparent 65%)`, animation: "drift 18s ease-in-out infinite" }} />
          <div style={{ position: "absolute", bottom: "10%", left: "-8%", width: "40%", height: "50%", borderRadius: "50%", background: "radial-gradient(ellipse,#4A308008 0%,transparent 60%)", animation: "drift 24s ease-in-out 4s infinite" }} />
          <div style={{ position: "absolute", top: "40%", left: "30%", width: "28%", height: "28%", borderRadius: "50%", background: `radial-gradient(ellipse,${C.gold}04 0%,transparent 60%)`, animation: "glow 9s ease-in-out infinite" }} />
        </div>

        <div className="hero-grid" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 80, alignItems: "center", maxWidth: 1200, margin: "0 auto", width: "100%", position: "relative" }}>

          {/* Copy */}
          <div style={{ animation: "fadeUp .9s ease forwards" }}>
            <Eyebrow>Remote DJ Collaboration</Eyebrow>

            <h1 style={{ fontFamily: "'Cormorant Garamond', serif", fontSize: "clamp(48px,5.2vw,80px)", fontWeight: 700, lineHeight: 1.0, letterSpacing: -1.5, margin: "0 0 24px", color: C.text }}>
              {"The music"}
              <br />
              <em style={{ color: C.gold, fontStyle: "italic" }}>{"doesn't stop"}</em>
              <br />
              {"at distance."}
            </h1>

            <p style={{ fontFamily: "'DM Sans', sans-serif", fontSize: 16, color: C.subtle, lineHeight: 1.85, maxWidth: 420, fontWeight: 300, margin: "0 0 40px" }}>
              Two DJs. Any city. One session. Match with DJs who share your taste, mix together live, and build your crew from anywhere in the world.
            </p>

            <div style={{ display: "flex", flexDirection: "column", gap: 10, maxWidth: 400 }}>
              <input
                value={djName}
                onChange={e => setDjName(e.target.value)}
                onKeyDown={e => e.key === "Enter" && handleLaunch()}
                placeholder="Enter your DJ name..."
                style={{ background: "rgba(255,255,255,0.05)", border: `1px solid ${C.gold}33`, borderRadius: 8, padding: "13px 16px", fontSize: 15, fontFamily: "'DM Sans', sans-serif", color: C.text, outline: "none", letterSpacing: 0.5 }}
              />
              <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
                <button onClick={handleLaunch} className="btn-gold" style={btnGold}>
                  {isJoining ? "JOIN THE ROOM →" : "OPEN THE ROOM"}
                </button>
                {!isJoining && <button onClick={() => scrollTo(communityRef)} className="btn-ghost" style={btnGhost}>SEE THE LOBBY {"↓"}</button>}
              </div>
            </div>

            <div style={{ marginTop: 32, display: "flex", gap: 18, alignItems: "center" }}>
              <div style={{ width: 1, height: 36, background: `${C.gold}20` }} />
              <div style={{ fontFamily: "'DM Mono', monospace", fontSize: 9, color: C.muted, letterSpacing: 2, lineHeight: 1.9 }}>
                <div>No account required to start</div>
                <div>Chrome {"&"} Edge {"·"} Free forever</div>
              </div>
            </div>
          </div>

          {/* App preview — hidden on mobile */}
          <div className="hero-preview" style={{ animation: "fadeUpD .9s ease .18s both", position: "relative" }}>
            <AppPreview />
            <div style={{ position: "absolute", bottom: -22, left: "50%", transform: "translateX(-50%)", background: C.dark2, border: `1px solid ${C.gold}18`, borderRadius: 20, padding: "5px 18px", whiteSpace: "nowrap" }}>
              <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 8, color: `${C.gold}77`, letterSpacing: 2 }}>LIVE SESSION PREVIEW</span>
            </div>
          </div>
        </div>

        {/* Stats */}
        <div className="stats-row" style={{ maxWidth: 1200, margin: "80px auto 0", width: "100%", paddingTop: 40, borderTop: `1px solid ${C.gold}10`, display: "flex", gap: 48, alignItems: "center", flexWrap: "wrap" }}>
          {[
            ["2",      "DJs per session"],
            ["4",      "Live decks"],
            ["100%",   "Browser-based"],
            ["Free",   "Always"],
          ].map(([val, label], i) => (
            <div key={i} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <div style={{ fontFamily: "'Cormorant Garamond', serif", fontSize: 36, fontWeight: 700, color: C.text, lineHeight: 1, letterSpacing: -1 }}>{val}</div>
              <div style={{ fontFamily: "'DM Mono', monospace", fontSize: 9, color: C.subtle, letterSpacing: 2, textTransform: "uppercase" }}>{label}</div>
            </div>
          ))}
        </div>
      </section>

      {/* ── TICKER ── */}
      <Ticker />

      {/* ── COMMUNITY / LOBBY PREVIEW ── */}
      <section ref={communityRef} className="section-pad" style={{ padding: "120px 48px", maxWidth: 1200, margin: "0 auto" }}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 56, alignItems: "end", marginBottom: 56 }}>
          <div>
            <Eyebrow>Global DJ Community</Eyebrow>
            <h2 style={{ fontFamily: "'Cormorant Garamond', serif", fontSize: "clamp(32px,4vw,54px)", fontWeight: 700, color: C.text, margin: 0, lineHeight: 1, letterSpacing: -1 }}>
              {"Find your partner."}
              <br />
              <em style={{ color: C.gold }}>{"Anywhere in the world."}</em>
            </h2>
          </div>
          <p style={{ fontFamily: "'DM Sans', sans-serif", fontSize: 15, color: C.subtle, lineHeight: 1.8, fontWeight: 300, maxWidth: 380 }}>
            Browse the lobby, filter by genre, and match with DJs who share your taste. Quick Match finds you a compatible partner in seconds -- like a game lobby, but for music.
          </p>
        </div>

        {/* Lobby cards */}
        <div className="lobby-grid" style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 10, marginBottom: 32 }}>
          {lobbyCards.map((card) => (
            <div key={card.name} className="lobby-card" style={{ background: C.dark2, border: `1px solid ${C.gold}14`, borderRadius: 10, padding: "14px 16px", display: "flex", flexDirection: "column", gap: 8 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                <div>
                  <div style={{ fontFamily: "'Cormorant Garamond', serif", fontSize: 16, fontWeight: 700, color: C.text }}>{card.name}</div>
                  <div style={{ fontFamily: "'DM Mono', monospace", fontSize: 8, color: C.subtle, letterSpacing: 1, marginTop: 2 }}>{card.location}</div>
                </div>
                <div style={{ display: "flex", gap: 5, alignItems: "center" }}>
                  <div style={{ width: 5, height: 5, borderRadius: "50%", background: card.status === "playing" ? "#22c55e" : C.gold, boxShadow: `0 0 6px ${card.status === "playing" ? "#22c55e" : C.gold}` }} />
                </div>
              </div>
              <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                {card.genres.map((g) => (
                  <span key={g} style={{ fontFamily: "'DM Mono', monospace", fontSize: 7, color: C.gold, background: `${C.gold}12`, border: `1px solid ${C.gold}20`, borderRadius: 10, padding: "2px 8px", letterSpacing: 1 }}>{g}</span>
                ))}
              </div>
              <div style={{ fontFamily: "'DM Mono', monospace", fontSize: 8, color: C.muted }}>{card.bpm} BPM</div>
            </div>
          ))}
        </div>

        {/* Quick match CTA */}
        <div style={{ background: `linear-gradient(135deg,${C.indigo},${C.dark2})`, border: `1px solid ${C.gold}18`, borderRadius: 12, padding: "28px 32px", display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 20 }}>
          <div>
            <div style={{ fontFamily: "'Cormorant Garamond', serif", fontSize: 22, fontWeight: 700, color: C.text, marginBottom: 6 }}>
              {"Ready to play? Find your match."}
            </div>
            <div style={{ fontFamily: "'DM Sans', sans-serif", fontSize: 13, color: C.subtle, fontWeight: 300 }}>
              Quick Match pairs you with a compatible DJ in seconds. No searching required.
            </div>
          </div>
          <button onClick={handleLaunch} className="btn-gold" style={btnGold}>QUICK MATCH {"→"}</button>
        </div>
      </section>

      {/* ── FEATURES ── */}
      <section ref={featuresRef} className="section-pad" style={{ padding: "80px 48px 120px", maxWidth: 1200, margin: "0 auto" }}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 56, alignItems: "end", marginBottom: 64 }}>
          <div>
            <Eyebrow>Built for professionals</Eyebrow>
            <h2 style={{ fontFamily: "'Cormorant Garamond', serif", fontSize: "clamp(32px,4vw,54px)", fontWeight: 700, color: C.text, margin: 0, lineHeight: 1, letterSpacing: -1 }}>
              {"Everything in the room."}
              <br />
              <em style={{ color: C.gold }}>{"Except the room."}</em>
            </h2>
          </div>
          <p style={{ fontFamily: "'DM Sans', sans-serif", fontSize: 15, color: C.subtle, lineHeight: 1.8, fontWeight: 300, maxWidth: 380 }}>
            Every feature you would expect from professional DJ software -- rebuilt for the browser, rebuilt for two. No compromises.
          </p>
        </div>

        <div className="feat-grid" style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 2 }}>
          {features.map((f) => (
            <div key={f.n} className="feat-card" style={{ padding: "32px 28px", borderRadius: 12, border: `1px solid ${C.gold}0C`, background: "transparent" }}>
              <div style={{ fontFamily: "'DM Mono', monospace", fontSize: 9, color: `${C.gold}55`, letterSpacing: 3, marginBottom: 14 }}>{f.n}</div>
              <div style={{ fontFamily: "'Cormorant Garamond', serif", fontSize: 20, fontWeight: 700, color: C.text, marginBottom: 10, letterSpacing: -0.3, lineHeight: 1.1 }}>{f.title}</div>
              <div style={{ fontFamily: "'DM Sans', sans-serif", fontSize: 13, color: C.subtle, lineHeight: 1.75, fontWeight: 300 }}>{f.body}</div>
            </div>
          ))}
        </div>
      </section>

      {/* ── WAVEFORM DIVIDER ── */}
      <div style={{ padding: "0 48px", maxWidth: 1200, margin: "0 auto 60px" }}>
        <div style={{ height: 1, background: `linear-gradient(90deg,transparent,${C.gold}22,transparent)` }} />
        <div style={{ marginTop: 32, opacity: 0.28 }}>
          <Waveform width={1100} height={52} opacity={1} speed={0.55} />
        </div>
        <div style={{ height: 1, marginTop: 32, background: `linear-gradient(90deg,transparent,${C.gold}22,transparent)` }} />
      </div>

      {/* ── HOW IT WORKS ── */}
      <section ref={howRef} className="section-pad how-grid" style={{ padding: "80px 48px 120px", maxWidth: 1200, margin: "0 auto", display: "grid", gridTemplateColumns: "1fr 1fr", gap: 80, alignItems: "start" }}>

        {/* Steps */}
        <div>
          <Eyebrow>Getting started</Eyebrow>
          <h2 style={{ fontFamily: "'Cormorant Garamond', serif", fontSize: "clamp(28px,3.5vw,48px)", fontWeight: 700, color: C.text, margin: "0 0 52px", lineHeight: 1, letterSpacing: -1 }}>
            {"The set starts"}
            <br />
            <em style={{ color: C.gold }}>{"when you both say so."}</em>
          </h2>
          <Step n="01" title="Open the room." body="No download. No account. Open Chrome or Edge and the room is ready." />
          <Step n="02" title="Create your profile." body="Set your DJ name, pick your genres, favorite labels, and BPM range. This is how others find you." />
          <Step n="03" title="Enter the lobby." body="Browse DJs online right now, filter by genre, or hit Quick Match to get paired instantly." />
          <Step n="04" title="Start playing." body="Load your tracks, hit play. Go live together and you hear each other's mix in real time." last />
        </div>

        {/* Sticky spec panel */}
        <div style={{ background: C.dark2, border: `1px solid ${C.gold}12`, borderRadius: 14, padding: "32px 28px", position: "sticky", top: 90 }}>
          <div style={{ fontFamily: "'DM Mono', monospace", fontSize: 9, color: `${C.gold}55`, letterSpacing: 3, marginBottom: 24, paddingBottom: 16, borderBottom: `1px solid ${C.gold}10` }}>
            TECHNICAL SPECIFICATIONS
          </div>
          {[
            ["Protocol",  "WebSocket + WebRTC"],
            ["Sync",      "Real-time state"],
            ["Audio",     "Opus codec, P2P"],
            ["Decks",     "2 per DJ, 4 total"],
            ["BPM Range", "60 to 200 BPM"],
            ["EQ",        "3-band per deck"],
            ["Recording", "WebM and WAV export"],
            ["MIDI",      "Web MIDI API"],
            ["Browser",   "Chrome or Edge"],
            ["Cost",      "Free"],
          ].map(([k, v]) => (
            <div key={k} className="spec-row" style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", padding: "11px 6px", borderBottom: `1px solid ${C.gold}08`, borderRadius: 4 }}>
              <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 10, color: C.muted, letterSpacing: 1 }}>{k}</span>
              <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 10, color: C.subtle }}>{v}</span>
            </div>
          ))}
          <button onClick={handleLaunch} className="btn-gold" style={{ ...btnGold, width: "100%", marginTop: 28, padding: "13px", fontSize: 10, letterSpacing: 2, borderRadius: 7 }}>
            OPEN THE ROOM {"→"}
          </button>
        </div>
      </section>

      {/* ── QUOTES ── */}
      <section className="quote-grid" style={{ padding: "100px 48px", textAlign: "center", background: C.dark2, borderTop: `1px solid ${C.gold}0A`, borderBottom: `1px solid ${C.gold}0A`, position: "relative", overflow: "hidden" }}>
        <div style={{ position: "absolute", top: "50%", left: "50%", transform: "translate(-50%,-50%)", width: "80%", height: "300%", borderRadius: "50%", background: `radial-gradient(ellipse,${C.gold}05 0%,transparent 55%)`, pointerEvents: "none" }} />
        <div style={{ position: "relative", maxWidth: 680, margin: "0 auto" }}>
          {[
            "Some rooms don't need walls.",
            "Two decks. Two cities. One moment.",
            "Play together. Be anywhere.",
          ].map((quote, i) => (
            <div key={i} className="quote-row" style={{ padding: "28px 0", borderBottom: i < 2 ? `1px solid ${C.gold}0C` : "none", cursor: "default" }}>
              <p style={{ fontFamily: "'Cormorant Garamond', serif", fontStyle: "italic", fontSize: "clamp(18px,2.8vw,30px)", color: i === 1 ? C.text : C.subtle, lineHeight: 1.3, margin: 0, fontWeight: 700, letterSpacing: -0.3 }}>
                {'"'}{quote}{'"'}
              </p>
            </div>
          ))}
          <div style={{ marginTop: 28 }}>
            <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 9, color: `${C.gold}44`, letterSpacing: 4 }}>{"— COLLAB//MIX"}</span>
          </div>
        </div>
      </section>

      {/* ── FINAL CTA ── */}
      <section className="section-pad" style={{ padding: "140px 48px", textAlign: "center", position: "relative", overflow: "hidden" }}>
        <div style={{ position: "absolute", top: "50%", left: "50%", transform: "translate(-50%,-50%)", width: 700, height: 700, borderRadius: "50%", background: `radial-gradient(circle,${C.gold}06 0%,transparent 60%)`, animation: "glow 7s ease-in-out infinite", pointerEvents: "none" }} />
        <div style={{ position: "relative", maxWidth: 580, margin: "0 auto" }}>
          <Eyebrow>Ready when you are</Eyebrow>
          <h2 style={{ fontFamily: "'Cormorant Garamond', serif", fontSize: "clamp(40px,5.5vw,72px)", fontWeight: 700, color: C.text, margin: "0 0 20px", lineHeight: 0.95, letterSpacing: -2 }}>
            {"Find your partner."}
            <br />
            <em style={{ color: C.gold }}>{"Start the session."}</em>
          </h2>
          <p style={{ fontFamily: "'DM Sans', sans-serif", fontSize: 15, color: C.subtle, margin: "0 0 44px", lineHeight: 1.8, fontWeight: 300 }}>
            No account. No download. Open the app, find your match, and you are mixing together in under a minute.
          </p>
          <button onClick={handleLaunch} className="btn-gold" style={{ ...btnGold, padding: "18px 56px", fontSize: 12, letterSpacing: 3 }}>
            OPEN THE ROOM
          </button>
          <div style={{ marginTop: 20, fontFamily: "'DM Mono', monospace", fontSize: 9, color: C.muted, letterSpacing: 2 }}>
            Free forever {"·"} No account {"·"} Chrome {"&"} Edge
          </div>
        </div>
      </section>

      {/* ── FOOTER ── */}
      <footer style={{ padding: "28px 48px", borderTop: `1px solid ${C.gold}0C`, display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 16, background: C.dark2 }}>
        <span style={{ fontFamily: "'Cormorant Garamond', serif", fontSize: 17, fontWeight: 700, color: C.muted, letterSpacing: -0.2 }}>
          {"Collab"}
          <span style={{ color: `${C.gold}55` }}>{"//"}</span>
          {"Mix"}
        </span>
        <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 9, color: `${C.muted}55`, letterSpacing: 1 }}>
          Mix together, from anywhere.
        </span>
        <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 9, color: `${C.muted}33`, letterSpacing: 1 }}>
          Chrome {"&"} Edge {"·"} HTTPS {"·"} Free
        </span>
      </footer>
    </div>
  );
}
