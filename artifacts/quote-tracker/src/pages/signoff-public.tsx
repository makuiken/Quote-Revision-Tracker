import { Printer, ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import React, { useState, useEffect, useRef } from "react";
import { useParams, Link } from "wouter";
import { useAuth } from "@clerk/react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetPublicSignoff,
  getGetPublicSignoffQueryKey,
  useSavePublicSignoff,
  useGetPublicManufacturerPacket,
  getGetPublicManufacturerPacketQueryKey,
  useGetPublicManufacturerPacketPage,
  getGetPublicManufacturerPacketPageQueryKey,
  useGetCurrentUser,
  getGetCurrentUserQueryKey,
} from "@workspace/api-client-react";
import { useToast } from "@/components/ui/toaster";
import { SignoffDocument } from "@/components/signoff-document";
import { SignoffReceiptView } from "@/components/signoff-receipt";

function PublicPacketViewer({ token, documentVersion, onStateChange, fallbackOpened, setFallbackOpened }: { token: string, documentVersion: string, onStateChange: (state: { hasManifest: boolean, isReady: boolean, error?: string }) => void, fallbackOpened: boolean, setFallbackOpened: (opened: boolean) => void }) {
  const { data: packet, isLoading, isError, error, refetch } = useGetPublicManufacturerPacket(token, {
    query: {
      retry: false,
      queryKey: [...getGetPublicManufacturerPacketQueryKey(token), documentVersion]
    }
  });

  const pageCount = packet?.pageCount || 0;
  const noPacket = isError && (error as { status?: number } | null)?.status === 404;
  const [loadedPages, setLoadedPages] = useState<Set<number>>(new Set());
  const [failedPages, setFailedPages] = useState<Set<number>>(new Set());
  const [fallbackError, setFallbackError] = useState<string | null>(null);
  const [isOpeningFallback, setIsOpeningFallback] = useState(false);

  useEffect(() => {
    setLoadedPages(new Set());
    setFailedPages(new Set());
    setFallbackOpened(false);
    setFallbackError(null);
  }, [documentVersion, packet, setFallbackOpened]);

  const openVerifiedFallback = async () => {
    const popup = window.open("", "_blank");
    if (!popup) {
      setFallbackError("The PDF could not open because the browser blocked the new window. Allow pop-ups and try again.");
      return;
    }
    popup.opener = null;
    setIsOpeningFallback(true);
    setFallbackError(null);
    try {
      const response = await fetch(`/api/public/signoff/${token}/document`);
      if (!response.ok || response.headers.get("content-type")?.includes("application/pdf") !== true) {
        throw new Error("The exact PDF is unavailable right now.");
      }
      const objectUrl = URL.createObjectURL(await response.blob());
      popup.location.href = objectUrl;
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
      setFallbackOpened(true);
    } catch (error) {
      popup.close();
      setFallbackError(error instanceof Error ? error.message : "The exact PDF could not be opened.");
      setFallbackOpened(false);
    } finally {
      setIsOpeningFallback(false);
    }
  };

  useEffect(() => {
    if (isLoading) {
      onStateChange({ hasManifest: false, isReady: false });
    } else if (noPacket) {
      onStateChange({ hasManifest: false, isReady: true });
    } else if (isError || failedPages.size > 0) {
      if (fallbackOpened) {
        onStateChange({ hasManifest: true, isReady: true });
      } else {
        onStateChange({ hasManifest: true, isReady: false, error: "One or more packet images failed to load." });
      }
    } else if (pageCount > 0) {
      onStateChange({ hasManifest: true, isReady: loadedPages.size === pageCount });
    } else {
      onStateChange({ hasManifest: false, isReady: true });
    }
  }, [isLoading, isError, noPacket, failedPages.size, pageCount, loadedPages.size, onStateChange, fallbackOpened]);

  const handlePageLoad = (pageNum: number) => {
    setLoadedPages(prev => {
      const next = new Set(prev);
      next.add(pageNum);
      return next;
    });
    setFailedPages((current) => {
      const next = new Set(current);
      next.delete(pageNum);
      return next;
    });
  };

  if (noPacket || (!isError && pageCount === 0)) return null;

  return (
    <div className="mb-12">
      <h2 className="text-xl font-bold uppercase tracking-widest border-b-2 border-black pb-2 mb-6">Manufacturer Specifications</h2>
      {(isError || failedPages.size > 0) && (
        <div className="mb-6 bg-amber-50 border border-amber-200 text-amber-900 p-4 rounded text-sm space-y-3" role="alert" aria-live="polite">
          <p className="font-bold">Image preview unavailable</p>
          <p>We couldn't load the manufacturer specification images right now. You can retry loading them, or view the exact approval document directly.</p>
          <div className="flex gap-3">
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setLoadedPages(new Set());
                refetch();
              }}
            >
              Retry Images
            </Button>
            <Button type="button" variant="default" size="sm" onClick={openVerifiedFallback} disabled={isOpeningFallback}>
              {isOpeningFallback ? "Opening PDF…" : "Open PDF Document"}
            </Button>
          </div>
          {fallbackError && <p className="pt-2 font-medium text-red-700" role="alert">{fallbackError}</p>}
          {fallbackOpened && (
            <p className="text-green-700 font-medium pt-2">
              Document opened. You may proceed with signing once you have reviewed the PDF.
            </p>
          )}
        </div>
      )}
      <div className="space-y-8">
        {Array.from({ length: pageCount }).map((_, i) => (
          <PublicPacketPage
            key={i}
            token={token}
            pageNumber={i + 1}
            documentVersion={documentVersion}
            onLoad={() => handlePageLoad(i + 1)}
            onError={() => setFailedPages((current) => new Set(current).add(i + 1))}
          />
        ))}
      </div>
    </div>
  );
}

function PublicPacketPage({ token, pageNumber, documentVersion, onLoad, onError }: { token: string, pageNumber: number, documentVersion: string, onLoad: () => void, onError: () => void }) {
  const { data: blob, isLoading, isError, refetch } = useGetPublicManufacturerPacketPage(token, pageNumber, { documentVersion }, {
    query: {
      retry: false,
      queryKey: getGetPublicManufacturerPacketPageQueryKey(token, pageNumber, { documentVersion })
    }
  });
  const [url, setUrl] = useState<string | null>(null);
  const onErrorRef = useRef(onError);

  useEffect(() => {
    onErrorRef.current = onError;
  }, [onError]);

  useEffect(() => {
    if (isError) onErrorRef.current();
  }, [isError]);

  useEffect(() => {
    if (blob) {
      const u = URL.createObjectURL(blob);
      setUrl(u);
      return () => URL.revokeObjectURL(u);
    }
    return undefined;
  }, [blob]);

  if (isError) {
    return (
      <div className="min-h-64 bg-red-50 flex flex-col gap-3 items-center justify-center text-red-800 rounded border border-red-200 p-6" role="alert">
        <p className="font-medium">Packet page {pageNumber} could not be loaded.</p>
        <Button type="button" variant="outline" size="sm" onClick={() => refetch()}>
          Retry this page
        </Button>
      </div>
    );
  }
  if (isLoading || !url) return <div className="h-64 bg-gray-100 animate-pulse rounded border border-gray-200"></div>;

  return (
    <div className="bg-white border border-gray-300 shadow-sm rounded overflow-hidden">
      <img src={url} alt={`Packet Page ${pageNumber}`} className="w-full h-auto block" onLoad={onLoad} onError={onError} />
    </div>
  );
}

/**
 * Public, customer-facing signing page. Reached via a tokenized share link —
 * no account or login required. The token gates all API access.
 */
export default function PublicSignoffPage() {
  const { token } = useParams();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [manifestState, setManifestState] = useState<{ hasManifest: boolean; isReady: boolean; error?: string }>({ hasManifest: false, isReady: false });
  const [fallbackOpened, setFallbackOpened] = useState(false);

  const handleManifestStateChange = React.useCallback((newState: { hasManifest: boolean, isReady: boolean, error?: string }) => {
    setManifestState(prev =>
      prev.hasManifest === newState.hasManifest && prev.isReady === newState.isReady && prev.error === newState.error
        ? prev
        : newState
    );
  }, []);

  const { data: detail, isLoading, isError } = useGetPublicSignoff(token ?? "", {
    query: { enabled: !!token, retry: false, queryKey: getGetPublicSignoffQueryKey(token ?? "") },
  });

  const savePublicSignoff = useSavePublicSignoff();
  const { isSignedIn } = useAuth();
  const { data: dbUser } = useGetCurrentUser({
    query: {
      enabled: Boolean(isSignedIn),
      retry: false,
      queryKey: getGetCurrentUserQueryKey(),
    },
  });
  const isEmployee = dbUser?.status === "approved";

  if (isLoading) {
    return (
      <div className="min-h-[100dvh] bg-gray-100 flex items-center justify-center text-gray-500">
        Loading document...
      </div>
    );
  }

  if (isError || !detail) {
    return (
      <div className="min-h-[100dvh] bg-gray-100 flex items-center justify-center p-8">
        <div className="bg-white border border-gray-200 rounded-lg shadow-lg p-8 max-w-md text-center">
          <h1 className="text-xl font-serif font-bold mb-2">Link Not Valid</h1>
          <p className="text-gray-600">
            This signing link is invalid or no longer active. Please contact your
            Kuiken Brothers representative for a new link.
          </p>
        </div>
      </div>
    );
  }

  const { quote, revisions } = detail;
  const legacyApproval = detail.legacyApproval ?? null;

  const submitSignoff = (
    signerName: string,
    stakeholderRole: "Homeowner" | "Contractor" | "Architect/Designer" | "Other",
    type: "typed" | "drawn",
    data: string,
  ) => {
    savePublicSignoff.mutate(
      {
        token: token!,
        data: {
          customerName: signerName,
          stakeholderRole,
          signatureType: type,
          signatureData: data,
          documentVersion: detail.documentVersion,
        },
      },
      {
        onSuccess: () => {
          toast({ title: "Thank You!", description: "Your signature has been recorded." });
          queryClient.invalidateQueries({ queryKey: getGetPublicSignoffQueryKey(token!) });
        },
        onError: (err) => {
          const stale = err.status === 409;
          toast({
            title: stale ? "Document Updated" : "Error",
            description: stale
              ? "This document was updated since you opened it. It has been refreshed — please review the latest version and sign again."
              : "We couldn't save your signature. Please try again.",
            variant: "destructive",
          });
          if (stale) queryClient.invalidateQueries({ queryKey: getGetPublicSignoffQueryKey(token!) });
        },
      },
    );
  };

  const disabledReason = legacyApproval
    ? "This current document is read-only because a historical legacy signature exists. It cannot replace that approval."
    : manifestState.error
      ? manifestState.error
      : (!manifestState.isReady ? "Loading manufacturer packet specifications..." : undefined);

  return (
    <div className="min-h-[100dvh] bg-gray-100 text-black font-sans print:bg-white print:p-0">
      <div className="max-w-4xl mx-auto p-4 sm:p-8 print:p-0">
        <div className="print:hidden flex justify-between items-center mb-8 pb-4 border-b-2 border-gray-300">
          <div>
            {isEmployee ? (
              <Button variant="ghost" asChild className="text-gray-600 hover:text-black -ml-4">
                <Link href={`/quotes/${quote.id}/signoff`}>
                  <ArrowLeft className="w-4 h-4 mr-2" /> Back to Approval Setup
                </Link>
              </Button>
            ) : (
              <Button variant="ghost" onClick={() => {
                if (window.history.length > 1 && document.referrer) {
                  window.history.back();
                }
              }} className={`text-gray-600 hover:text-black -ml-4 ${typeof window !== 'undefined' && window.history.length > 1 && document.referrer ? '' : 'hidden'}`}>
                <ArrowLeft className="w-4 h-4 mr-2" /> Back
              </Button>
            )}
          </div>
          <Button
            onClick={() => window.print()}
            disabled={!detail.receipt && (!manifestState.isReady || !!manifestState.error)}
            title="Print this document, or choose Save as PDF in the print dialog."
            className="bg-black text-white hover:bg-gray-800"
          >
            <Printer className="w-4 h-4 mr-2" /> Print / Save PDF
          </Button>
        </div>
        <div className="mb-6 rounded-md border border-amber-300 bg-amber-50 p-4 text-sm text-amber-950 print:hidden">
          <p><strong>{legacyApproval ? "Historical signature notice:" : "Current review document:"}</strong> this HTML page shows the current quote content and is not proof of an earlier signature. Only an immutable signed PDF is approval evidence.</p>
        </div>
        {detail.receipt ? (
          <SignoffReceiptView receipt={detail.receipt} />
        ) : (
          <SignoffDocument
            quote={quote}
            revisions={revisions}
            signoff={null}
            isSigned={false}
            onSubmit={submitSignoff}
            isSubmitting={savePublicSignoff.isPending}
            hasManifest={manifestState.hasManifest}
            disabledReason={disabledReason}
            packetSection={<PublicPacketViewer key={detail.documentVersion} token={token!} documentVersion={detail.documentVersion} onStateChange={handleManifestStateChange} fallbackOpened={fallbackOpened} setFallbackOpened={setFallbackOpened} />}
          />
        )}
      </div>
    </div>
  );
}
