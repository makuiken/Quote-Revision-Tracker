import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

export default function LandingPage() {
  const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");
  return (
    <div className="min-h-[100dvh] flex flex-col bg-background relative overflow-hidden">
      <div 
        className="absolute inset-0 opacity-[0.03] pointer-events-none" 
        style={{ backgroundImage: "repeating-linear-gradient(45deg, #244234 0, #244234 2px, transparent 2px, transparent 12px)" }}
      ></div>
      <header className="px-6 py-6 flex items-center justify-between relative z-10 max-w-7xl mx-auto w-full">
        <img src={`${basePath}/logo.png`} alt="Kuiken Brothers" className="h-16 w-auto" />
      </header>
      <main className="flex-1 flex flex-col items-center justify-center text-center px-4 relative z-10">
        <div className="max-w-3xl space-y-8">
          <Badge variant="outline" className="border-secondary text-secondary bg-secondary/10 px-4 py-1.5 text-sm rounded-full tracking-widest font-bold">
            Internal Tool
          </Badge>
          <h1 className="text-5xl md:text-7xl font-serif font-bold text-primary leading-tight">
            Quote Revision Tracker
          </h1>
          <p className="text-lg md:text-xl text-muted-foreground font-medium max-w-2xl mx-auto leading-relaxed">A dependable logbook for the architectural millwork sales team. Track quote revisions, log updates, and generate signoff documents.</p>
          
          <div className="flex flex-col sm:flex-row items-center justify-center gap-4 pt-8">
            <Button asChild size="lg" className="w-full sm:w-auto text-lg px-12 h-14 rounded-md">
              <Link href="/sign-in">Sign In</Link>
            </Button>
            <Button asChild variant="outline" size="lg" className="w-full sm:w-auto text-lg px-12 h-14 rounded-md bg-card border-2">
              <Link href="/sign-up">Request Access</Link>
            </Button>
          </div>
        </div>
      </main>
      <footer className="py-8 text-center text-muted-foreground font-medium text-sm relative z-10">
        Kuiken Brothers Company, Inc. &copy; {new Date().getFullYear()}
      </footer>
    </div>
  );
}
