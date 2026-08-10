import { useParams, Link } from "wouter";
import { format } from "date-fns";
import { ArrowLeft, Printer } from "lucide-react";
import { useGetQuote, getGetQuoteQueryKey } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";

export default function PrintLogPage() {
  const { id } = useParams();
  const quoteId = parseInt(id || "0", 10);
  const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

  const { data: detail, isLoading } = useGetQuote(quoteId, { 
    query: { enabled: !!quoteId, queryKey: getGetQuoteQueryKey(quoteId) } 
  });

  if (isLoading) {
    return <div className="p-8 text-center text-muted-foreground">Loading...</div>;
  }

  if (!detail) {
    return <div className="p-8 text-center text-destructive">Quote not found.</div>;
  }

  const { quote, revisions } = detail;

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
          <Button onClick={() => window.print()} className="bg-black text-white hover:bg-gray-800">
            <Printer className="w-4 h-4 mr-2" /> Print Document
          </Button>
        </div>

        {/* Printable Document */}
        <div className="space-y-8">
          <div className="flex items-center justify-between border-b-4 border-black pb-6">
            <img src={`${basePath}/logo.svg`} alt="Kuiken Brothers" className="h-12" style={{ filter: 'grayscale(100%)' }} />
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
            <h2 className="text-xl font-bold uppercase tracking-widest border-b-2 border-black pb-2 mb-6">Complete Update History</h2>
            
            {revisions.length === 0 ? (
              <p className="text-gray-500 italic">No revisions have been logged for this quote.</p>
            ) : (
              <div className="space-y-6">
                {revisions.map((rev, index) => (
                  <div key={rev.id} className="flex gap-6 pb-6 border-b border-gray-200 break-inside-avoid">
                    <div className="w-12 h-12 rounded-full bg-gray-100 flex items-center justify-center shrink-0 font-bold text-gray-400">
                      {index + 1}
                    </div>
                    <div className="flex-1 space-y-2">
                      <div className="flex items-baseline justify-between">
                        <span className="font-bold text-lg">{rev.authorName}</span>
                        <span className="text-sm text-gray-500 font-bold">{format(new Date(rev.createdAt), "MMMM d, yyyy 'at' h:mm a")}</span>
                      </div>
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