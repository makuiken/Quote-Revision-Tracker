import { useState } from "react";
import { useParams, Link } from "wouter";
import { format } from "date-fns";
import { ArrowLeft, Printer } from "lucide-react";
import { useGetQuote, getGetQuoteQueryKey } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { categoryLabel } from "@/lib/revision-categories";

export default function PrintLogPage() {
  const { id } = useParams();
  const quoteId = parseInt(id || "0", 10);
  const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

  const { data: detail, isLoading } = useGetQuote(quoteId, { 
    query: { enabled: !!quoteId, queryKey: getGetQuoteQueryKey(quoteId) } 
  });

  // "all" shows everything; a category id limits the printout to revisions
  // tagged with that category (untagged entries count as "general/all" and
  // are always included).
  const [categoryFilter, setCategoryFilter] = useState<string>("all");

  if (isLoading) {
    return <div className="p-8 text-center text-muted-foreground">Loading...</div>;
  }

  if (!detail) {
    return <div className="p-8 text-center text-destructive">Quote not found.</div>;
  }

  const { quote, revisions } = detail;

  const filteredRevisions =
    categoryFilter === "all"
      ? revisions
      : revisions.filter(
          (rev) =>
            !rev.categories?.length ||
            (rev.categories as string[]).includes(categoryFilter),
        );

  return (
    <div className="min-h-[100dvh] bg-white text-black font-sans print:bg-white print:p-0">
      <div className="max-w-4xl mx-auto p-8 print:p-0">
        
        {/* Screen-only controls */}
        <div className="print:hidden flex items-center justify-between mb-8 pb-4 border-b-2 border-gray-200">
          <Button asChild variant="ghost" className="text-gray-600 hover:text-black hover:bg-gray-100">
            <Link href={`/quotes/${quote.id}`}>
              <ArrowLeft className="w-4 h-4 mr-2" /> Back to Quote
            </Link>
          </Button>
          <div className="flex items-center gap-3">
            <label htmlFor="categoryFilter" className="text-sm font-bold text-gray-600 uppercase tracking-wider">
              Filter
            </label>
            <select
              id="categoryFilter"
              value={categoryFilter}
              onChange={(e) => setCategoryFilter(e.target.value)}
              className="border-2 border-gray-300 rounded-md px-3 py-2 text-sm font-bold bg-white text-black"
            >
              <option value="all">All categories</option>
              {quote.categories.map((cat) => (
                <option key={cat} value={cat}>
                  {categoryLabel(cat)}
                </option>
              ))}
            </select>
            <Button onClick={() => window.print()} className="bg-black text-white hover:bg-gray-800">
              <Printer className="w-4 h-4 mr-2" /> Print Document
            </Button>
          </div>
        </div>

        {/* Printable Document */}
        <div className="space-y-8">
          <div className="flex items-center justify-between border-b-4 border-black pb-6">
            <img src={`${basePath}/logo.png`} alt="Kuiken Brothers" className="h-12" style={{ filter: 'grayscale(100%)' }} />
            <div className="text-right">
              <h1 className="text-3xl font-serif font-bold text-black uppercase tracking-widest">Revision Log</h1>
              <p className="text-lg font-bold text-gray-600 mt-1">{format(new Date(), "MMMM d, yyyy")}</p>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-8 text-lg">
            <div>
              <p className="text-sm font-bold text-gray-500 uppercase tracking-widest mb-1">Quote Number</p>
              <p className="font-serif font-bold text-2xl">{quote.quoteNumber}</p>
            </div>
            <div>
              <p className="text-sm font-bold text-gray-500 uppercase tracking-widest mb-1">Customer / Project</p>
              <p className="font-serif font-bold text-2xl">{quote.displayName}</p>
              <p className="text-gray-600 mt-1">{quote.jobAddress}</p>
            </div>
          </div>

          <div className="pt-8">
            <h2 className="text-xl font-bold uppercase tracking-widest border-b-2 border-black pb-2 mb-6">
              {categoryFilter === "all"
                ? "Complete Update History"
                : `Update History — ${categoryLabel(categoryFilter)}`}
            </h2>
            
            {filteredRevisions.length === 0 ? (
              <p className="text-gray-500 italic">
                {revisions.length === 0
                  ? "No revisions have been logged for this quote."
                  : `No revisions match the ${categoryLabel(categoryFilter)} filter.`}
              </p>
            ) : (
              <div className="space-y-6">
                {filteredRevisions.map((rev, index) => (
                  <div key={rev.id} className="flex gap-6 pb-6 border-b border-gray-200 break-inside-avoid">
                    <div className="w-12 h-12 rounded-full bg-gray-100 flex items-center justify-center shrink-0 font-bold text-gray-400">
                      {index + 1}
                    </div>
                    <div className="flex-1 space-y-2">
                      <div className="flex items-baseline justify-between">
                        <span className="font-bold text-lg">{rev.authorName}</span>
                        <span className="text-sm text-gray-500 font-bold">{format(new Date(rev.createdAt), "MMMM d, yyyy 'at' h:mm a")}</span>
                      </div>
                      {(rev.categories?.length ?? 0) > 0 && (
                        <div className="flex flex-wrap gap-1.5">
                          {rev.categories!.map((tag) => (
                            <span
                              key={tag}
                              className="text-[10px] font-bold uppercase tracking-wider border border-gray-400 text-gray-600 rounded-full px-2 py-0.5"
                            >
                              {categoryLabel(tag)}
                            </span>
                          ))}
                        </div>
                      )}
                      <p className="text-gray-800 whitespace-pre-wrap leading-relaxed">{rev.note}</p>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}