import { useState, useEffect, useRef } from "react";
import { Link } from "wouter";
import { format } from "date-fns";
import { Search, Plus, FileText, ArrowRight, User, ChevronLeft, ChevronRight } from "lucide-react";
import { 
  useListQuotes, 
  getListQuotesQueryKey,
  useGetRecentActivity,
  useListTeamMembers,
  useGetCurrentUser,
  type ListQuotesParams,
} from "@workspace/api-client-react";
import { Shell } from "@/components/layout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

type StatusFilter = "all" | "awaiting" | "signed" | "archived";
type CategoryFilter = "all" | "interiorDoors" | "exteriorDoors" | "windows" | "trim" | "millwork";
const PAGE_SIZE = 25;
const categoryLabel: Record<CategoryFilter, string> = { all: "All", interiorDoors: "Int. Doors", exteriorDoors: "Ext. Doors", windows: "Windows", trim: "Moulding", millwork: "Misc." };
// Display labels for category badges (legacy "doors" quotes still render).
const badgeLabel: Record<string, string> = { doors: "Doors", interiorDoors: "Interior Doors", exteriorDoors: "Exterior Doors", windows: "Windows", trim: "Moulding", millwork: "Millwork" };

export default function DashboardPage() {
  const [searchTerm, setSearchTerm] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [categoryFilter, setCategoryFilter] = useState<CategoryFilter>("all");
  // Filter by immutable user ID ("all" = no filter).
  const [userFilter, setUserFilter] = useState<string>("all");
  // Default to showing only the viewer's own quotes; collaboration is infrequent.
  const [viewScope, setViewScope] = useState<"mine" | "everyone">("mine");
  const [page, setPage] = useState(0);

  const searchTimerRef = useRef<number | null>(null);

  // Any filter change restarts pagination from the first page.
  useEffect(() => {
    setPage(0);
  }, [debouncedSearch, statusFilter, categoryFilter, userFilter, viewScope]);

  useEffect(() => {
    if (searchTimerRef.current) window.clearTimeout(searchTimerRef.current);
    searchTimerRef.current = window.setTimeout(() => {
      setDebouncedSearch(searchTerm);
    }, 400);
    return () => {
      if (searchTimerRef.current) window.clearTimeout(searchTimerRef.current);
    };
  }, [searchTerm]);

  const { data: teamMembers } = useListTeamMembers();
  const { data: me } = useGetCurrentUser();

  // All filtering happens server-side. "My Quotes" filters by the viewer's
  // immutable user ID; in "Everyone" scope an explicit user can be picked.
  const createdById =
    viewScope === "mine" ? me?.id : userFilter !== "all" ? userFilter : undefined;

  // Until the profile loads, hold the query so "My Quotes" never flashes a
  // wrong list.
  const canQuery = viewScope !== "mine" || !!me;
  const quoteListParams: ListQuotesParams = {
    search: debouncedSearch || undefined,
    // "All Status" still hides archived quotes; they live under Archived.
    status: statusFilter === "all" ? "active" : statusFilter,
    category: categoryFilter !== "all" ? categoryFilter : undefined,
    createdById,
    offset: page * PAGE_SIZE,
    limit: PAGE_SIZE,
  };
  const { data: quotePage, isLoading: isLoadingQuotes } = useListQuotes(
    quoteListParams,
    { query: { enabled: canQuery, queryKey: getListQuotesQueryKey(quoteListParams) } },
  );
  // "My Quotes" scope is applied server-side for activity, by creator ID.
  const { data: activity } = useGetRecentActivity({
    limit: 5,
    mine: viewScope === "mine" ? true : undefined,
  });

  const isLoadingList = isLoadingQuotes || !canQuery;
  const filteredQuotes = quotePage?.items;
  const totalQuotes = quotePage?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(totalQuotes / PAGE_SIZE));

  const visibleActivity = activity ?? [];

  return (
    <Shell>
      <div className="mb-8 flex flex-col md:flex-row md:items-end justify-between gap-4">
        <div>
          <h1 className="text-3xl font-serif font-bold text-primary mb-2">Dashboard</h1>
          <p className="text-muted-foreground font-medium">Overview of all active quotes and recent activity.</p>
        </div>
        <Button asChild size="lg" className="shrink-0 shadow-sm text-base">
          <Link href="/quotes/new">
            <Plus className="w-5 h-5 mr-2" />
            New Quote
          </Link>
        </Button>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        <div className="lg:col-span-2 space-y-6">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <h2 className="text-2xl font-serif font-bold text-foreground">Quotes</h2>
            <div className="relative flex-1 max-w-sm">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
              <Input 
                type="search" 
                placeholder="Search by quote # or project..." 
                className="pl-9 bg-card shadow-sm"
                value={searchTerm}
                onChange={e => setSearchTerm(e.target.value)}
              />
            </div>
          </div>

          <div className="flex flex-wrap gap-4">
            <div className="flex items-center bg-card border-2 border-border rounded-md overflow-hidden p-1 shadow-sm">
              <Button 
                variant={viewScope === "mine" ? "default" : "ghost"} 
                size="sm" 
                className={`rounded ${viewScope === "mine" ? "" : "hover:bg-accent/50"} h-8 px-4`}
                onClick={() => setViewScope("mine")}
              >My Quotes</Button>
              <Button 
                variant={viewScope === "everyone" ? "default" : "ghost"} 
                size="sm" 
                className={`rounded ${viewScope === "everyone" ? "" : "hover:bg-accent/50"} h-8 px-4`}
                onClick={() => { setViewScope("everyone"); }}
              >Everyone</Button>
            </div>

            <div className="flex items-center bg-card border-2 border-border rounded-md overflow-hidden p-1 shadow-sm">
              <Button 
                variant={statusFilter === "all" ? "default" : "ghost"} 
                size="sm" 
                className={`rounded ${statusFilter === "all" ? "" : "hover:bg-accent/50"} h-8 px-4`}
                onClick={() => setStatusFilter("all")}
              >All Status</Button>
              <Button 
                variant={statusFilter === "awaiting" ? "default" : "ghost"} 
                size="sm" 
                className={`rounded ${statusFilter === "awaiting" ? "" : "hover:bg-accent/50"} h-8 px-4`}
                onClick={() => setStatusFilter("awaiting")}
              >Awaiting</Button>
              <Button 
                variant={statusFilter === "signed" ? "default" : "ghost"} 
                size="sm" 
                className={`rounded ${statusFilter === "signed" ? "" : "hover:bg-accent/50"} h-8 px-4`}
                onClick={() => setStatusFilter("signed")}
              >Signed</Button>
              <Button 
                variant={statusFilter === "archived" ? "default" : "ghost"} 
                size="sm" 
                className={`rounded ${statusFilter === "archived" ? "" : "hover:bg-accent/50"} h-8 px-4`}
                onClick={() => setStatusFilter("archived")}
              >Archived</Button>
            </div>

            <div className="flex items-center bg-card border-2 border-border rounded-md overflow-hidden p-1 shadow-sm overflow-x-auto">
              {(["all", "interiorDoors", "exteriorDoors", "windows", "trim", "millwork"] as CategoryFilter[]).map(cat => (
                <Button 
                  key={cat}
                  variant={categoryFilter === cat ? "default" : "ghost"} 
                  size="sm" 
                  className={`rounded ${categoryFilter === cat ? "" : "hover:bg-accent/50"} h-8 px-4`}
                  onClick={() => setCategoryFilter(cat)}
                >{categoryLabel[cat]}</Button>
              ))}
            </div>

            {viewScope === "everyone" && (
              <Select value={userFilter} onValueChange={setUserFilter}>
                <SelectTrigger aria-label="Filter quotes by user" className="w-full sm:w-[200px] bg-card border-2 border-border shadow-sm font-medium">
                  <User aria-hidden="true" className="w-4 h-4 text-muted-foreground shrink-0" />
                  <SelectValue placeholder="All users" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All users</SelectItem>
                  {teamMembers?.map(member => (
                    <SelectItem key={member.id} value={member.userId}>{member.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>

          <Card className="overflow-hidden">
            {isLoadingList ? (
              <div className="p-8 text-center text-muted-foreground font-medium">Loading quotes...</div>
            ) : filteredQuotes?.length === 0 ? (
              <div className="p-12 text-center flex flex-col items-center">
                <FileText className="w-12 h-12 text-muted-foreground/50 mb-4" />
                <h3 className="text-lg font-bold text-foreground mb-2">No quotes found</h3>
                <p className="text-muted-foreground mb-6">
                  {debouncedSearch || statusFilter !== "all" || categoryFilter !== "all" || userFilter !== "all" ? "Try adjusting your filters." : "Press the green button to start your first one."}
                </p>
                {(!debouncedSearch && statusFilter === "all" && categoryFilter === "all" && userFilter === "all") && (
                  <Button asChild>
                    <Link href="/quotes/new">Create Quote</Link>
                  </Button>
                )}
              </div>
            ) : (
              <div className="divide-y-2 divide-border">
                {filteredQuotes?.map(quote => (
                  <Link key={quote.id} href={`/quotes/${quote.id}`} className="block hover:bg-muted/30 transition-colors p-4 sm:p-6 outline-none focus-visible:bg-muted/30">
                    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                      <div className="space-y-1">
                        <div className="flex items-center gap-3">
                          <span className="font-bold text-lg text-foreground">{quote.quoteNumber}</span>
                          {quote.archived ? (
                            <Badge variant="outline" className="text-muted-foreground">Archived</Badge>
                          ) : quote.signed ? (
                            <Badge variant="success">Signed</Badge>
                          ) : (
                            <Badge variant="warning">Awaiting Signoff</Badge>
                          )}
                        </div>
                        <p className="text-muted-foreground font-medium flex items-center gap-2">
                          <User className="w-4 h-4" />
                          {quote.displayName}
                        </p>
                        <div className="flex flex-wrap gap-2 mt-2 pt-1">
                          {quote.categories.map(cat => (
                            <Badge key={cat} variant="outline" className="bg-background">{badgeLabel[cat] ?? cat}</Badge>
                          ))}
                        </div>
                      </div>
                      <div className="text-right sm:text-left flex sm:flex-col items-center sm:items-end justify-between sm:justify-center gap-2">
                        <span className="text-sm font-bold text-muted-foreground bg-muted px-2 py-1 rounded-md">
                          {quote.revisionCount} {quote.revisionCount === 1 ? 'Revision' : 'Revisions'}
                        </span>
                        <div className="text-sm text-primary font-bold flex items-center gap-1">
                          View details <ArrowRight className="w-4 h-4" />
                        </div>
                      </div>
                    </div>
                  </Link>
                ))}
              </div>
            )}
          </Card>

          {!isLoadingList && totalQuotes > PAGE_SIZE && (
            <div className="flex items-center justify-between">
              <p className="text-sm text-muted-foreground font-medium">
                Showing {page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, totalQuotes)} of {totalQuotes} quotes
              </p>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={page === 0}
                  onClick={() => setPage(p => Math.max(0, p - 1))}
                >
                  <ChevronLeft className="w-4 h-4 mr-1" />
                  Previous
                </Button>
                <span className="text-sm text-muted-foreground font-medium">
                  Page {page + 1} of {pageCount}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={page + 1 >= pageCount}
                  onClick={() => setPage(p => p + 1)}
                >
                  Next
                  <ChevronRight className="w-4 h-4 ml-1" />
                </Button>
              </div>
            </div>
          )}
        </div>

        <div className="space-y-6">
          <h2 className="text-2xl font-serif font-bold text-foreground">Recent Activity</h2>
          <Card>
            <CardContent className="p-0 h-[480px] overflow-y-auto">
              {visibleActivity.length === 0 ? (
                <div className="p-6 text-center text-muted-foreground font-medium">No activity yet.</div>
              ) : (
                <div className="divide-y divide-border/50">
                  {visibleActivity.map(entry => (
                    <div key={entry.id} className="p-5 flex gap-4">
                      <div className="w-2 h-2 mt-2 rounded-full bg-secondary shrink-0"></div>
                      <div className="space-y-1">
                        <p className="text-sm font-bold text-foreground">
                          {entry.authorName} updated <Link href={`/quotes/${entry.quoteId}`} className="text-primary hover:underline">{entry.quoteNumber}</Link>
                        </p>
                        <p className="text-xs text-muted-foreground font-medium">
                          {format(new Date(entry.createdAt), "MMM d, h:mm a")}
                        </p>
                        <p className="text-sm text-muted-foreground mt-2 italic border-l-2 border-border pl-3 whitespace-pre-line">
                          "{entry.note}"
                        </p>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </Shell>
  );
}