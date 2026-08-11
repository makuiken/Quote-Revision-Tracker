import { Show, useClerk, useUser } from "@clerk/react";
import { Link, Redirect, useLocation } from "wouter";
import { LogOut, Home, FileText, Users, Clock } from "lucide-react";
import { useGetCurrentUser, getGetCurrentUserQueryKey } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";

export function Shell({ children }: { children: React.ReactNode }) {
  const { signOut } = useClerk();
  const { user } = useUser();
  const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");
  const [location] = useLocation();

  const { data: dbUser, isLoading } = useGetCurrentUser({
    query: {
      queryKey: getGetCurrentUserQueryKey(),
      retry: false,
    }
  });

  return (
    <>
      <Show when="signed-out">
        <Redirect to="/" />
      </Show>
      <Show when="signed-in">
        {isLoading ? (
          <div className="min-h-[100dvh] flex items-center justify-center bg-background">
            <p className="text-muted-foreground font-medium">Loading...</p>
          </div>
        ) : dbUser?.status === "rejected" ? (
          <div className="min-h-[100dvh] flex flex-col items-center justify-center bg-background p-4 text-center">
            <img src={`${basePath}/logo.png`} alt="Kuiken Brothers" className="h-24 mb-8 w-auto" />
            <h1 className="text-3xl font-serif font-bold text-primary mb-2">Company Email Required</h1>
            <p className="text-muted-foreground font-medium max-w-md mb-8">
              This tool is only available to Kuiken Brothers team members. Please sign in with your @kuikenbrothers.com email address.
            </p>
            <Button onClick={() => signOut({ redirectUrl: basePath || "/" })} variant="outline" size="lg">
              <LogOut className="w-4 h-4 mr-2" />
              Log out
            </Button>
          </div>
        ) : dbUser?.status === "pending" ? (
          <div className="min-h-[100dvh] flex flex-col items-center justify-center bg-background p-4 text-center">
            <img src={`${basePath}/logo.png`} alt="Kuiken Brothers" className="h-24 mb-8 w-auto" />
            <Clock className="w-16 h-16 text-secondary mb-4" />
            <h1 className="text-3xl font-serif font-bold text-primary mb-2">Account Awaiting Approval</h1>
            <p className="text-muted-foreground font-medium max-w-md mb-8">
              Your account has been created successfully, but it needs to be approved by an administrator before you can access the Quote Tracker.
            </p>
            <Button onClick={() => signOut({ redirectUrl: basePath || "/" })} variant="outline" size="lg">
              <LogOut className="w-4 h-4 mr-2" />
              Log out
            </Button>
          </div>
        ) : (
          <div className="min-h-[100dvh] flex flex-col bg-background">
            <div className="sticky top-0 z-10 shadow-sm">
            <header className="bg-card border-b-2 border-border px-4 py-3 flex items-center justify-between">
              <Link href="/quotes" className="flex items-center gap-3 no-underline outline-none focus-visible:ring-2 focus-visible:ring-primary rounded">
                <img src={`${basePath}/logo.png`} alt="Kuiken Brothers" className="h-14 w-auto" />
                <span className="font-serif font-bold text-2xl text-primary hidden sm:inline-block">Quote Tracker</span>
              </Link>
              
              <div className="flex items-center gap-3 md:gap-6">
                <nav className="hidden md:flex items-center gap-6 mr-4 border-r-2 border-border pr-6">
                  <Link href="/quotes" className={`flex items-center gap-2 font-bold transition-colors ${location === "/quotes" ? "text-primary" : "text-foreground hover:text-primary"}`}>
                    <Home className="w-5 h-5" />
                    Dashboard
                  </Link>
                  <Link href="/quotes/new" className={`flex items-center gap-2 font-bold transition-colors ${location === "/quotes/new" ? "text-primary" : "text-foreground hover:text-primary"}`}>
                    <FileText className="w-5 h-5" />
                    New Quote
                  </Link>
                  {dbUser?.role === "admin" && (
                    <Link href="/team" className={`flex items-center gap-2 font-bold transition-colors ${location === "/team" ? "text-primary" : "text-foreground hover:text-primary"}`}>
                      <Users className="w-5 h-5" />
                      Team
                    </Link>
                  )}
                </nav>
                
                <div className="flex items-center gap-2 sm:gap-4">
                  <div className="hidden sm:flex flex-col items-end">
                    <span className="text-sm font-bold text-foreground leading-tight">
                      {user?.firstName} {user?.lastName}
                    </span>
                    <span className="text-xs text-muted-foreground leading-tight capitalize">
                      {dbUser?.role || "Sales Team"}
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

            <nav className="md:hidden bg-card border-b-2 border-border px-4 py-2 flex items-center gap-2 overflow-x-auto">
              <Link href="/quotes" className={`flex items-center gap-2 text-sm font-bold whitespace-nowrap px-3 py-2 rounded-md transition-colors ${location === "/quotes" ? "bg-primary/10 text-primary" : "text-foreground hover:text-primary"}`}>
                <Home className="w-4 h-4" />
                Dashboard
              </Link>
              <Link href="/quotes/new" className={`flex items-center gap-2 text-sm font-bold whitespace-nowrap px-3 py-2 rounded-md transition-colors ${location === "/quotes/new" ? "bg-primary/10 text-primary" : "text-foreground hover:text-primary"}`}>
                <FileText className="w-4 h-4" />
                New Quote
              </Link>
              {dbUser?.role === "admin" && (
                <Link href="/team" className={`flex items-center gap-2 text-sm font-bold whitespace-nowrap px-3 py-2 rounded-md transition-colors ${location === "/team" ? "bg-primary/10 text-primary" : "text-foreground hover:text-primary"}`}>
                  <Users className="w-4 h-4" />
                  Team
                </Link>
              )}
            </nav>
            </div>

            <main className="flex-1 w-full max-w-[1600px] mx-auto p-4 sm:p-6 md:p-8 flex flex-col">
              {children}
            </main>
            
            <footer className="py-6 text-center text-sm text-muted-foreground font-medium border-t-2 border-border mt-auto bg-card">
              Kuiken Brothers Company, Inc. &copy; {new Date().getFullYear()}
            </footer>
          </div>
        )}
      </Show>
    </>
  );
}