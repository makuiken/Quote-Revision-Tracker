const base = import.meta.env.BASE_URL;

export default function WhatsNext() {
  return (
    <div className="w-screen h-screen overflow-hidden relative flex flex-col box-border bg-bg text-text font-body" style={{ padding: "8vh 8vw" }}>
      <div className="absolute bg-primary" style={{ width: "84vw", height: "0.2vh", top: "8vh", left: "8vw" }} />

      <div className="flex justify-between items-end" style={{ marginTop: "2vh" }}>
        <img src={`${base}logo.png`} crossOrigin="anonymous" alt="Kuiken Brothers" style={{ height: "3.6vh", width: "auto" }} />
        <div className="text-muted" style={{ fontSize: "1vw", fontWeight: 400 }}>Roadmap</div>
      </div>

      <div
        className="absolute select-none"
        style={{ top: "35vh", left: "8vw", fontSize: "25vw", fontWeight: 700, color: "#F5F5F5", lineHeight: 0.8, zIndex: 0, letterSpacing: "-0.05em" }}
      >
        09
      </div>

      <div className="relative z-10 flex flex-col justify-start grow" style={{ marginTop: "8vh" }}>
        <h2 style={{ fontSize: "3.5vw", fontWeight: 600, margin: "0 0 6vh 0", lineHeight: 1.1, letterSpacing: "-0.02em" }}>
          What's next
        </h2>

        <div className="flex flex-col" style={{ gap: "4vh", maxWidth: "64vw" }}>
          <div className="flex" style={{ gap: "3vw" }}>
            <div style={{ fontWeight: 600, fontSize: "1.4vw", width: "18vw", letterSpacing: "-0.01em", fontFamily: "'DM Mono', monospace" }}>01</div>
            <div className="text-accent" style={{ fontSize: "1.4vw", lineHeight: 1.5, flex: 1 }}>Customer signing via shared link, no account required</div>
          </div>
          <div style={{ width: "100%", height: "0.1vh", backgroundColor: "#E0E0E0" }} />
          <div className="flex" style={{ gap: "3vw" }}>
            <div style={{ fontWeight: 600, fontSize: "1.4vw", width: "18vw", letterSpacing: "-0.01em", fontFamily: "'DM Mono', monospace" }}>02</div>
            <div className="text-accent" style={{ fontSize: "1.4vw", lineHeight: 1.5, flex: 1 }}>Publish the app for the full sales team</div>
          </div>
          <div style={{ width: "100%", height: "0.1vh", backgroundColor: "#E0E0E0" }} />
          <div className="flex" style={{ gap: "3vw" }}>
            <div style={{ fontWeight: 600, fontSize: "1.4vw", width: "18vw", letterSpacing: "-0.01em", fontFamily: "'DM Mono', monospace" }}>03</div>
            <div className="text-accent" style={{ fontSize: "1.4vw", lineHeight: 1.5, flex: 1 }}>Gather feedback from the first jobs and iterate</div>
          </div>
        </div>
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
          <div className="text-primary" style={{ fontWeight: 600 }}>09</div>
        </div>
      </div>
    </div>
  );
}
