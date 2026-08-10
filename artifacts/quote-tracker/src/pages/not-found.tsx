import { Link } from "wouter";
import { Button } from "@/components/ui/button";

export default function NotFound() {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-background text-center px-4">
      <h1 className="text-8xl font-serif font-bold text-primary mb-4">404</h1>
      <h2 className="text-2xl font-bold text-foreground mb-4">Page Not Found</h2>
      <p className="text-muted-foreground max-w-md mb-8">
        The page you are looking for doesn't exist or has been moved.
      </p>
      <Button asChild size="lg">
        <Link href="/">Return to Home</Link>
      </Button>
    </div>
  );
}