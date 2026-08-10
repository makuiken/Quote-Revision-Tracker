import { Show, useClerk, useUser } from "@clerk/react";
import { Link, Redirect } from "wouter";
import { LogOut, Home, FileText } from "lucide-react";

export function Shell({ children }: { children: React.ReactNode }) {
  const { signOut } = useClerk();
  const { user } = useUser();
  const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

  return (
    <>
      <Show when="signed-out">
        <Redirect to="/" />
      </Show>
      <Show when="signed-in">
        <div className="min-h-[100dvh] flex flex-col bg-background">
          <header className="sticky top-0 z-10 bg-card border-b-2 border-border px-4 py-3 flex items-center justify-between shadow-sm">
            <Link href="/quotes" className="flex items-center gap-3 no-underline outline-none focus-visible:ring-2 focus-visible:ring-primary rounded">
              <img src={`${basePath}/logo.svg`} alt="Kuiken Brothers" className="h-10" />
              <span className="font-serif font-bold text-2xl text-primary hidden sm:inline-block">Quote Tracker</span>
            </Link>
            
            <div className="flex items-center gap-6">
              <nav className="hidden md:flex items-center gap-6 mr-4 border-r-2 border-border pr-6">
                <Link href="/quotes" className="flex items-center gap-2 text-foreground font-bold hover:text-primary transition-colors">
                  <Home className="w-5 h-5" />
                  Dashboard
                </Link>
                <Link href="/quotes/new" className="flex items-center gap-2 text-foreground font-bold hover:text-primary transition-colors">
                  <FileText className="w-5 h-5" />
                  New Quote
                </Link>
              </nav>
              
              <div className="flex items-center gap-4">
                <div className="flex flex-col items-end">
                  <span className="text-sm font-bold text-foreground leading-tight">
                    {user?.firstName} {user?.lastName}
                  </span>
                  <span className="text-xs text-muted-foreground leading-tight">
                    Sales Team
                  </span>
                </div>
                <button 
                  onClick={() => signOut({ redirectUrl: basePath || "/" })}
                  className="flex items-center gap-2 text-sm text-secondary hover:text-destructive transition-colors font-bold bg-secondary/10 px-3 py-2 rounded-md focus-visible:ring-2 focus-visible:ring-destructive focus-visible:outline-none"
                  title="Log out"
                >
                  <LogOut className="w-4 h-4" />
                  <span className="hidden sm:inline">Log out</span>
                </button>
              </div>
            </div>
          </header>
          
          <main className="flex-1 w-full max-w-5xl mx-auto p-4 sm:p-6 md:p-8 flex flex-col">
            {children}
          </main>
          
          <footer className="py-6 text-center text-sm text-muted-foreground font-medium border-t-2 border-border mt-auto bg-card">
            Kuiken Brothers Company, Inc. &copy; {new Date().getFullYear()}
          </footer>
        </div>
      </Show>
    </>
  );
}
