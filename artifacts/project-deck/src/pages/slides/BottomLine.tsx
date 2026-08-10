const base = import.meta.env.BASE_URL;

export default function BottomLine() {
  return (
    <div className="w-screen h-screen overflow-hidden relative flex flex-col box-border bg-bg text-text font-body" style={{ padding: "8vh 8vw" }}>
      <div className="absolute bg-primary" style={{ width: "84vw", height: "0.2vh", top: "8vh", left: "8vw" }} />

      <div className="flex justify-between items-end" style={{ marginTop: "2vh" }}>
        <img src={`${base}logo.png`} crossOrigin="anonymous" alt="Kuiken Brothers" style={{ height: "4.5vh", width: "auto" }} />
        <div className="text-muted" style={{ fontSize: "1vw", fontWeight: 400 }}>Summary</div>
      </div>

      <div
        className="absolute select-none"
        style={{ top: "35vh", left: "8vw", fontSize: "25vw", fontWeight: 700, color: "#F5F5F5", lineHeight: 0.8, zIndex: 0, letterSpacing: "-0.05em" }}
      >
        10
      </div>

      <div className="relative z-10 flex flex-col justify-center grow" style={{ marginTop: "4vh" }}>
        <h2 style={{ fontSize: "4.6vw", fontWeight: 600, margin: "0 0 4vh 0", lineHeight: 1.15, letterSpacing: "-0.03em", maxWidth: "72vw", textWrap: "balance" }}>
          The bottom line
        </h2>
        <p className="text-accent" style={{ fontSize: "2vw", lineHeight: 1.5, maxWidth: "58vw", textWrap: "pretty" }}>
          Every quote change documented. Every signoff on the current version. Fewer disputes, faster jobs.
        </p>
      </div>

      <div
        className="flex flex-row z-10 text-accent"
        style={{ gap: "8vw", borderTop: "0.1vh solid #E0E0E0", paddingTop: "3vh", marginTop: "auto", fontFamily: "'DM Mono', monospace", fontSize: "0.9vw" }}
      >
        <div>
          <div className="uppercase" style={{ color: "#888888", marginBottom: "0.5vh", fontSize: "0.7vw" }}>Date</div>
          <div>August 2026</div>
        </div>
        <div>
          <div className="uppercase" style={{ color: "#888888", marginBottom: "0.5vh", fontSize: "0.7vw" }}>Prepared By</div>
          <div>Millwork Sales Team</div>
        </div>
        <div style={{ marginLeft: "auto", textAlign: "right" }}>
          <div className="uppercase" style={{ color: "#888888", marginBottom: "0.5vh", fontSize: "0.7vw" }}>Page</div>
          <div className="text-primary" style={{ fontWeight: 600 }}>10</div>
        </div>
      </div>
    </div>
  );
}
