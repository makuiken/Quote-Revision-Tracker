import { useEffect, useRef } from "react";
import { ClerkProvider, SignIn, SignUp, Show, useClerk } from "@clerk/react";
import { publishableKeyFromHost } from "@clerk/react/internal";
import { shadcn } from "@clerk/themes";
import { Switch, Route, useLocation, Router as WouterRouter, Redirect } from "wouter";
import { QueryClient, QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import { ErrorBoundary } from "@/components/error-boundary";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";

// Pages
import LandingPage from "@/pages/landing";
import DashboardPage from "@/pages/dashboard";
import NewQuotePage from "@/pages/quote-new";
import QuoteDetailPage from "@/pages/quote-detail";
import PrintLogPage from "@/pages/print-log";
import SignoffPage from "@/pages/signoff";
import PublicSignoffPage from "@/pages/signoff-public";
import TeamPage from "@/pages/team";
import NotFound from "@/pages/not-found";

const queryClient = new QueryClient();

const clerkPubKey = publishableKeyFromHost(
  window.location.hostname,
  import.meta.env.VITE_CLERK_PUBLISHABLE_KEY,
);

const clerkProxyUrl = import.meta.env.VITE_CLERK_PROXY_URL;
const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

function stripBase(path: string): string {
  return basePath && path.startsWith(basePath)
    ? path.slice(basePath.length) || "/"
    : path;
}

if (!clerkPubKey) {
  throw new Error("Missing VITE_CLERK_PUBLISHABLE_KEY in .env file");
}

const clerkAppearance = {
  theme: shadcn,
  cssLayerName: "clerk",
  options: {
    logoPlacement: "inside" as const,
    logoLinkUrl: basePath || "/",
    logoImageUrl: `${window.location.origin}${basePath}/logo.png`,
  },
  variables: {
    colorPrimary: "hsl(152 29% 20%)", // primary green
    colorForeground: "hsl(43 7% 16%)", // dark gray
    colorMutedForeground: "hsl(43 7% 40%)",
    colorDanger: "hsl(0 84% 60%)",
    colorBackground: "hsl(43 33% 98%)", // card bg
    colorInput: "hsl(43 33% 98%)",
    colorInputForeground: "hsl(43 7% 16%)",
    colorNeutral: "hsl(43 15% 85%)", // borders
    fontFamily: "'Plus Jakarta Sans', sans-serif",
    borderRadius: "0.3rem",
  },
  elements: {
    rootBox: "w-full flex justify-center",
    cardBox: "bg-card rounded-xl w-[440px] max-w-full overflow-hidden border-2 border-border shadow-md",
    card: "!shadow-none !border-0 !bg-transparent !rounded-none",
    footer: "!shadow-none !border-0 !bg-transparent !rounded-none",
    headerTitle: "font-serif text-2xl font-bold text-primary",
    headerSubtitle: "text-muted-foreground text-sm font-medium",
    socialButtonsBlockButtonText: "font-bold",
    formFieldLabel: "font-bold text-foreground",
    footerActionLink: "text-primary hover:text-primary/80 font-bold",
    footerActionText: "text-muted-foreground font-medium",
    dividerText: "text-muted-foreground font-bold",
    identityPreviewEditButton: "text-secondary hover:text-secondary/80",
    formFieldSuccessText: "text-green-700 font-medium",
    alertText: "font-medium",
    logoBox: "mb-6 flex justify-center",
    logoImage: "h-20 w-auto",
    socialButtonsBlockButton: "border-2 border-border hover:bg-muted/50 rounded-md transition-colors",
    formButtonPrimary: "bg-primary text-primary-foreground font-bold hover:bg-primary/90 rounded-md py-2.5",
    formFieldInput: "border-2 border-border rounded-md px-3 py-2 text-foreground focus:ring-2 focus:ring-primary focus:border-transparent outline-none transition-shadow",
    footerAction: "mt-6",
    dividerLine: "bg-border",
    alert: "border-2 border-destructive/20 bg-destructive/10 rounded-md",
    otpCodeFieldInput: "border-2 border-border rounded-md",
    formFieldRow: "mb-4",
    main: "p-6 sm:p-8",
  },
};

function SignInPage() {
  return (
    <div className="flex min-h-[100dvh] items-center justify-center bg-background px-4 py-12">
      <SignIn routing="path" path={`${basePath}/sign-in`} signUpUrl={`${basePath}/sign-up`} />
    </div>
  );
}

function SignUpPage() {
  return (
    <div className="flex min-h-[100dvh] items-center justify-center bg-background px-4 py-12">
      <SignUp routing="path" path={`${basePath}/sign-up`} signInUrl={`${basePath}/sign-in`} />
    </div>
  );
}

function HomeRedirect() {
  return (
    <>
      <Show when="signed-in">
        <Redirect to="/quotes" />
      </Show>
      <Show when="signed-out">
        <LandingPage />
      </Show>
    </>
  );
}

function ClerkQueryClientCacheInvalidator() {
  const { addListener } = useClerk();
  const queryClient = useQueryClient();
  const prevUserIdRef = useRef<string | null | undefined>(undefined);

  useEffect(() => {
    const unsubscribe = addListener(({ user }) => {
      const userId = user?.id ?? null;
      if (
        prevUserIdRef.current !== undefined &&
        prevUserIdRef.current !== userId
      ) {
        queryClient.clear();
      }
      prevUserIdRef.current = userId;
    });
    return unsubscribe;
  }, [addListener, queryClient]);

  return null;
}

function RoutedErrorBoundary({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();
  return <ErrorBoundary resetKey={location}>{children}</ErrorBoundary>;
}

function ClerkProviderWithRoutes() {
  const [, setLocation] = useLocation();

  return (
    <ClerkProvider
      publishableKey={clerkPubKey}
      proxyUrl={clerkProxyUrl}
      appearance={clerkAppearance}
      signInUrl={`${basePath}/sign-in`}
      signUpUrl={`${basePath}/sign-up`}
      localization={{
        signIn: {
          start: {
            title: "Sales Login",
            subtitle: "Sign in to access the Quote Tracker",
          },
        },
        signUp: {
          start: {
            title: "Join Quote Tracker",
            subtitle: "Create your team account",
          },
        },
      }}
      routerPush={(to) => setLocation(stripBase(to))}
      routerReplace={(to) => setLocation(stripBase(to), { replace: true })}
    >
      <QueryClientProvider client={queryClient}>
        <ClerkQueryClientCacheInvalidator />
        <TooltipProvider>
          <RoutedErrorBoundary>
            <Switch>
              <Route path="/" component={HomeRedirect} />
              <Route path="/sign-in/*?" component={SignInPage} />
              <Route path="/sign-up/*?" component={SignUpPage} />
              <Route path="/quotes" component={DashboardPage} />
              <Route path="/quotes/new" component={NewQuotePage} />
              <Route path="/quotes/:id" component={QuoteDetailPage} />
              <Route path="/quotes/:id/print-log" component={PrintLogPage} />
              <Route path="/quotes/:id/signoff" component={SignoffPage} />
              <Route path="/sign/:token" component={PublicSignoffPage} />
              <Route path="/team" component={TeamPage} />
              <Route component={NotFound} />
            </Switch>
          </RoutedErrorBoundary>
          <Toaster />
        </TooltipProvider>
      </QueryClientProvider>
    </ClerkProvider>
  );
}

export default function App() {
  return (
    <WouterRouter base={basePath}>
      <ClerkProviderWithRoutes />
    </WouterRouter>
  );
}