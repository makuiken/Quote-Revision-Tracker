import { useEffect, useRef, useState } from "react";
import { ArrowLeft, Download, Printer, RefreshCcw } from "lucide-react";
import { Link, useParams } from "wouter";
import {
  getGetScopedApprovalPacketPageQueryKey,
  getGetScopedApprovalSignoffSnapshotQueryKey,
  getScopedApprovalDocument,
  useGetScopedApprovalPacketPage,
  useGetScopedApprovalSignoffSnapshot,
  type ScopedApprovalPacketPage,
  type ScopedApprovalSignoffSnapshot,
} from "@workspace/api-client-react";
import { SignoffDocument } from "@/components/signoff-document";
import { Button } from "@/components/ui/button";
import { categoryLabel } from "@/lib/revision-categories";

type PacketViewerState = {
  ready: boolean;
  failed: boolean;
};

function HistoricalPacketPage({
  quoteId,
  approvalId,
  page,
  retryNonce,
  onLoad,
  onError,
}: {
  quoteId: number;
  approvalId: number;
  page: ScopedApprovalPacketPage;
  retryNonce: number;
  onLoad: () => void;
  onError: () => void;
}) {
  const { data: blob, isLoading, isError, refetch } = useGetScopedApprovalPacketPage(
    quoteId,
    approvalId,
    page.pageNumber,
    {
      query: {
        retry: false,
        queryKey: [
          ...getGetScopedApprovalPacketPageQueryKey(quoteId, approvalId, page.pageNumber),
          retryNonce,
        ],
      },
    },
  );
  const [url, setUrl] = useState<string | null>(null);
  const onErrorRef = useRef(onError);
  const onLoadRef = useRef(onLoad);

  useEffect(() => {
    onErrorRef.current = onError;
    onLoadRef.current = onLoad;
  }, [onError, onLoad]);

  useEffect(() => {
    if (isError) onErrorRef.current();
  }, [isError]);

  useEffect(() => {
    if (!blob) {
      setUrl(null);
      return undefined;
    }
    const objectUrl = URL.createObjectURL(blob);
    setUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [blob]);

  if (isError) {
    return (
      <div
        className="flex min-h-64 flex-col items-center justify-center gap-3 rounded border border-red-200 bg-red-50 p-6 text-red-800"
        role="alert"
      >
        <p className="font-medium">Packet page {page.pageNumber} could not be loaded.</p>
        <Button type="button" variant="outline" size="sm" onClick={() => refetch()}>
          <RefreshCcw className="mr-2 h-3.5 w-3.5" /> Retry this page
        </Button>
      </div>
    );
  }

  if (isLoading || !url) {
    return <div className="h-64 animate-pulse rounded border border-gray-200 bg-gray-100" aria-label={`Loading packet page ${page.pageNumber}`} />;
  }

  return (
    <div className="overflow-hidden rounded border border-gray-300 bg-white shadow-sm">
      <img
        src={url}
        alt={`Original approved manufacturer packet page ${page.pageNumber}`}
        className="block h-auto w-full"
        onLoad={() => onLoadRef.current()}
        onError={() => onErrorRef.current()}
      />
    </div>
  );
}

function HistoricalPacketViewer({
  quoteId,
  approvalId,
  pages,
  onStateChange,
}: {
  quoteId: number;
  approvalId: number;
  pages: ScopedApprovalPacketPage[];
  onStateChange: (state: PacketViewerState) => void;
}) {
  const [loadedPages, setLoadedPages] = useState<Set<number>>(new Set());
  const [failedPages, setFailedPages] = useState<Set<number>>(new Set());
  const [retryNonce, setRetryNonce] = useState(0);

  useEffect(() => {
    setLoadedPages(new Set());
    setFailedPages(new Set());
    setRetryNonce(0);
  }, [quoteId, approvalId, pages]);

  useEffect(() => {
    onStateChange({
      ready: pages.length === 0 || loadedPages.size === pages.length,
      failed: failedPages.size > 0,
    });
  }, [failedPages.size, loadedPages.size, onStateChange, pages.length]);

  if (pages.length === 0) return null;

  const retryImages = () => {
    setLoadedPages(new Set());
    setFailedPages(new Set());
    setRetryNonce((value) => value + 1);
  };

  return (
    <section className="mb-12">
      <h2 className="mb-6 border-b-2 border-black pb-2 text-xl font-bold uppercase tracking-widest">
        Original Manufacturer Specifications
      </h2>
      <div className="mb-6 rounded border border-blue-200 bg-blue-50 p-4 text-sm text-blue-900">
        These pages are the exact sanitized packet pages captured in this approval snapshot.
      </div>
      {failedPages.size > 0 && (
        <div className="mb-6 space-y-3 rounded border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900" role="alert" aria-live="polite">
          <p className="font-bold">One or more packet images failed to load.</p>
          <p>Printing is disabled until every original packet page is ready.</p>
          <Button type="button" variant="outline" size="sm" onClick={retryImages}>
            <RefreshCcw className="mr-2 h-3.5 w-3.5" /> Retry images
          </Button>
        </div>
      )}
      <div className="space-y-8">
        {pages.map((page) => (
          <div key={`${page.packetId}:${page.pageNumber}`} className="break-inside-avoid">
            <p className="mb-2 text-xs font-bold uppercase tracking-widest text-gray-500">
              Page {page.pageNumber} · {categoryLabel(page.productType)}
            </p>
            <HistoricalPacketPage
              quoteId={quoteId}
              approvalId={approvalId}
              page={page}
              retryNonce={retryNonce}
              onLoad={() => {
                setLoadedPages((current) => new Set(current).add(page.pageNumber));
                setFailedPages((current) => {
                  const next = new Set(current);
                  next.delete(page.pageNumber);
                  return next;
                });
              }}
              onError={() => setFailedPages((current) => new Set(current).add(page.pageNumber))}
            />
          </div>
        ))}
      </div>
    </section>
  );
}

function SnapshotStatus({ snapshot }: { snapshot: ScopedApprovalSignoffSnapshot }) {
  return (
    <section className="mb-6 rounded-lg border border-border bg-card p-4 print:hidden" aria-label="Historical signoff status">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-xs font-bold uppercase tracking-widest text-muted-foreground">Immutable signed evidence</p>
          <p className="mt-1 text-sm text-foreground">
            The document below uses the original approval snapshot, not the current quote.
          </p>
        </div>
        <div className="text-right text-xs font-bold uppercase tracking-wider">
          <p className={snapshot.status === "signed" ? "text-green-700" : "text-amber-700"}>
            Evidence: {snapshot.status === "signed" ? "Current" : "Historical — not fully current"}
          </p>
          <p className={snapshot.linkStatus === "active" ? "text-green-700" : "text-red-700"}>
            Link access: {snapshot.linkStatus}
          </p>
          <p className="text-muted-foreground">
            Request lifecycle: {snapshot.requestStatus}
          </p>
        </div>
      </div>
      {snapshot.invalidationReason && (
        <div className="mt-3 rounded border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
          <strong>Original evidence status reason:</strong> {snapshot.invalidationReason}
        </div>
      )}
      {snapshot.linkStatus !== "active" && (
        <p className="mt-3 text-xs font-medium text-muted-foreground">
          Public link lifecycle is shown separately and does not change the original signed content.
        </p>
      )}
    </section>
  );
}

export default function SignoffSnapshotPage() {
  const { id, approvalId: approvalIdParam } = useParams();
  const quoteId = Number(id);
  const approvalId = Number(approvalIdParam);
  const validParams = Number.isInteger(quoteId) && quoteId > 0 && Number.isInteger(approvalId) && approvalId > 0;
  const [packetReady, setPacketReady] = useState(false);
  const [packetFailed, setPacketFailed] = useState(false);
  const [isDownloading, setIsDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);

  const snapshotQuery = useGetScopedApprovalSignoffSnapshot(quoteId, approvalId, {
    query: {
      enabled: validParams,
      retry: false,
      queryKey: getGetScopedApprovalSignoffSnapshotQueryKey(quoteId, approvalId),
    },
  });
  const snapshot = snapshotQuery.data;

  const downloadOriginalPdf = async () => {
    setIsDownloading(true);
    setDownloadError(null);
    try {
      const pdf = await getScopedApprovalDocument(quoteId, approvalId, { responseType: "blob" });
      const objectUrl = URL.createObjectURL(pdf);
      const anchor = document.createElement("a");
      anchor.href = objectUrl;
      anchor.download = `quote-${quoteId}-scoped-approval-${approvalId}-original.pdf`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
    } catch (error) {
      setDownloadError(error instanceof Error ? error.message : "The original signed PDF could not be downloaded.");
    } finally {
      setIsDownloading(false);
    }
  };

  const retrySnapshot = () => {
    void snapshotQuery.refetch();
  };

  if (!validParams) {
    return (
      <div className="flex min-h-[100dvh] items-center justify-center p-8 text-destructive">
        Invalid signed approval link.
      </div>
    );
  }

  if (snapshotQuery.isLoading) {
    return <div className="flex min-h-[100dvh] items-center justify-center bg-muted text-muted-foreground">Loading immutable signoff snapshot…</div>;
  }

  if (snapshotQuery.isError || !snapshot) {
    return (
      <div className="flex min-h-[100dvh] items-center justify-center bg-muted p-8">
        <div className="max-w-md rounded-lg border border-border bg-card p-8 text-center shadow-sm">
          <h1 className="font-serif text-xl font-bold">Signed approval unavailable</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            The original immutable approval snapshot could not be loaded. Current quote data was not substituted.
          </p>
          <div className="mt-6 flex justify-center gap-3">
            <Button type="button" variant="outline" onClick={retrySnapshot}>Retry</Button>
            <Button asChild variant="ghost"><Link href={`/quotes/${quoteId}`}>Back to quote</Link></Button>
          </div>
        </div>
      </div>
    );
  }

  const onPacketStateChange = (state: PacketViewerState) => {
    setPacketReady(state.ready);
    setPacketFailed(state.failed);
  };

  return (
    <div className="min-h-[100dvh] bg-muted text-foreground print:bg-white">
      <div className="mx-auto max-w-4xl p-4 sm:p-8 print:p-0">
        <header className="mb-6 flex flex-col gap-4 md:flex-row md:items-center md:justify-between print:hidden">
          <div>
            <Button asChild variant="ghost" className="-ml-2 text-muted-foreground">
              <Link href={`/quotes/${quoteId}`}><ArrowLeft className="mr-2 h-4 w-4" /> Back to quote</Link>
            </Button>
            <h1 className="mt-2 font-serif text-3xl font-extrabold tracking-tight">View or print signoff</h1>
            <p className="mt-1 text-sm font-medium text-muted-foreground">
              Historical approval #{approvalId} · Prepared {new Date(snapshot.preparedAt).toLocaleDateString()}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              onClick={() => window.print()}
              disabled={!packetReady || packetFailed}
              title={packetReady ? "Print this exact formatted signoff document or choose Save as PDF." : "Wait until every packet page has loaded before printing."}
            >
              <Printer className="mr-2 h-4 w-4" /> Print / Save PDF
            </Button>
            <Button type="button" variant="outline" onClick={downloadOriginalPdf} disabled={isDownloading}>
              <Download className="mr-2 h-4 w-4" /> {isDownloading ? "Downloading…" : "Download original PDF"}
            </Button>
          </div>
        </header>

        <SnapshotStatus snapshot={snapshot} />
        {downloadError && (
          <div className="mb-6 rounded border border-red-200 bg-red-50 p-3 text-sm text-red-800" role="alert">
            {downloadError}
          </div>
        )}
        <SignoffDocument
          quote={snapshot.quote}
          revisions={snapshot.revisions}
          signoff={snapshot.signoff}
          isSigned
          productTypes={snapshot.productTypes}
          notIncludedProductTypes={snapshot.notIncludedProductTypes}
          preparedAt={new Date(snapshot.preparedAt).toISOString()}
          hasManifest={snapshot.packetPages.length > 0}
          packetSection={
            <HistoricalPacketViewer
              quoteId={quoteId}
              approvalId={approvalId}
              pages={snapshot.packetPages}
              onStateChange={onPacketStateChange}
            />
          }
          onSubmit={() => undefined}
        />
      </div>
    </div>
  );
}