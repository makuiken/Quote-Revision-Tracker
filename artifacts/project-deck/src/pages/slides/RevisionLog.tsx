const base = import.meta.env.BASE_URL;

export default function RevisionLog() {
  return (
    <div className="w-screen h-screen overflow-hidden relative flex flex-col box-border bg-bg text-text font-body" style={{ padding: "8vh 8vw" }}>
      <div className="absolute bg-primary" style={{ width: "84vw", height: "0.2vh", top: "8vh", left: "8vw" }} />

      <div className="flex justify-between items-end" style={{ marginTop: "2vh" }}>
        <img src={`${base}logo.png`} crossOrigin="anonymous" alt="Kuiken Brothers" style={{ height: "3.6vh", width: "auto" }} />
        <div className="text-muted" style={{ fontSize: "1vw", fontWeight: 400 }}>Revision History</div>
      </div>

      <div
        className="absolute select-none"
        style={{ top: "35vh", left: "8vw", fontSize: "25vw", fontWeight: 700, color: "#F5F5F5", lineHeight: 0.8, zIndex: 0, letterSpacing: "-0.05em" }}
      >
        05
      </div>

      <div className="relative z-10 flex justify-between items-start grow" style={{ marginTop: "8vh", gap: "4vw" }}>
        <div className="flex flex-col" style={{ maxWidth: "42vw" }}>
          <h2 style={{ fontSize: "3.2vw", fontWeight: 600, margin: "0 0 5vh 0", lineHeight: 1.1, letterSpacing: "-0.02em", textWrap: "balance" }}>
            A revision log you can stand behind
          </h2>

          <div className="flex flex-col" style={{ gap: "3vh" }}>
            <div className="text-accent" style={{ fontSize: "1.3vw", lineHeight: 1.5, borderLeft: "0.2vh solid #1C1C1C", paddingLeft: "1.5vw" }}>
              Timestamped entry for every change, with the author's name
            </div>
            <div className="text-accent" style={{ fontSize: "1.3vw", lineHeight: 1.5, borderLeft: "0.2vh solid #1C1C1C", paddingLeft: "1.5vw" }}>
              Automatic entries when specs are edited — nothing relies on memory
            </div>
            <div className="text-accent" style={{ fontSize: "1.3vw", lineHeight: 1.5, borderLeft: "0.2vh solid #1C1C1C", paddingLeft: "1.5vw" }}>
              Printable revision history for the job file
            </div>
          </div>
        </div>

        <img
          src={`${base}revision-log.jpg`}
          crossOrigin="anonymous"
          alt="Printed revision log document"
          style={{ width: "36vw", height: "52vh", objectFit: "cover", border: "0.1vh solid #E0E0E0" }}
        />
      </div>

      <div
        className="flex flex-row z-10 text-accent"
        style={{ gap: "8vw", borderTop: "0.1vh solid #E0E0E0", paddingTop: "3vh", marginTop: "4vh", fontFamily: "'DM Mono', monospace", fontSize: "0.9vw" }}
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
          <div className="text-primary" style={{ fontWeight: 600 }}>05</div>
        </div>
      </div>
    </div>
  );
}
