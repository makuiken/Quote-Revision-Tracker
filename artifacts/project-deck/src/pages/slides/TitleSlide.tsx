const base = import.meta.env.BASE_URL;

export default function TitleSlide() {
  return (
    <div className="w-screen h-screen overflow-hidden relative flex flex-col box-border bg-bg text-text font-body" style={{ padding: "8vh 8vw" }}>
      <div className="absolute bg-primary" style={{ width: "84vw", height: "0.2vh", top: "8vh", left: "8vw" }} />

      <div className="flex justify-between items-end" style={{ marginTop: "2vh" }}>
        <img src={`${base}logo.png`} crossOrigin="anonymous" alt="Kuiken Brothers" style={{ height: "4.5vh", width: "auto" }} />
        <div className="text-muted" style={{ fontSize: "1vw", fontWeight: 400 }}>Kuiken Brothers — Millwork Sales Team</div>
      </div>

      <div
        className="absolute select-none"
        style={{ top: "35vh", left: "8vw", fontSize: "25vw", fontWeight: 700, color: "#F5F5F5", lineHeight: 0.8, zIndex: 0, letterSpacing: "-0.05em" }}
      >
        01
      </div>

      <div className="relative z-10 flex flex-col justify-center grow" style={{ marginTop: "10vh" }}>
        <h1 style={{ fontSize: "5.6vw", fontWeight: 600, margin: 0, lineHeight: 1.1, letterSpacing: "-0.02em", maxWidth: "72vw", textWrap: "balance" }}>
          Quote Revision Tracker
        </h1>
        <p className="text-accent" style={{ fontSize: "1.8vw", fontWeight: 400, marginTop: "3vh", maxWidth: "54vw", lineHeight: 1.4, textWrap: "pretty" }}>
          A single source of truth for millwork quotes, revisions, and customer signoffs
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
        <div>
          <div className="uppercase" style={{ color: "#888888", marginBottom: "0.5vh", fontSize: "0.7vw" }}>Status</div>
          <div className="text-primary" style={{ fontWeight: 600 }}>Internal</div>
        </div>
      </div>
    </div>
  );
}
