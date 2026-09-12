import { Printer, ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import React, { useState, useEffect } from "react";
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
  useGetCurrentUser,
  getGetCurrentUserQueryKey,
} from "@workspace/api-client-react";
import { useToast } from "@/components/ui/toaster";
import { SignoffDocument } from "@/components/signoff-document";

function PublicPacketViewer({ token, documentVersion, onStateChange }: { token: string, documentVersion: string, onStateChange: (state: { hasManifest: boolean, isReady: boolean, error?: string }) => void }) {
  const { data: packet, isLoading, isError, error } = useGetPublicManufacturerPacket(token, {
    query: {
      retry: false,
      queryKey: [...getGetPublicManufacturerPacketQueryKey(token), documentVersion]
    }
  });

  const pageCount = packet?.pageCount || 0;
  const noPacket = isError && (error as { status?: number } | null)?.status === 404;
  const [loadedPages, setLoadedPages] = useState<Set<number>>(new Set());
  const [imageError, setImageError] = useState(false);

  useEffect(() => {
    setLoadedPages(new Set());
    setImageError(false);
  }, [packet]);

  useEffect(() => {
    if (isLoading) {
      onStateChange({ hasManifest: false, isReady: false });
    } else if ((isError && !noPacket) || imageError) {
      onStateChange({ hasManifest: pageCount > 0, isReady: false, error: "One or more packet images failed to load. Please refresh the page." });
    } else if (pageCount > 0) {
      onStateChange({ hasManifest: true, isReady: loadedPages.size === pageCount });
    } else {
      onStateChange({ hasManifest: false, isReady: true });
    }
  }, [isLoading, isError, noPacket, imageError, pageCount, loadedPages.size, onStateChange]);

  const handlePageLoad = (pageNum: number) => {
    setLoadedPages(prev => {
      const next = new Set(prev);
      next.add(pageNum);
      return next;
    });
  };

  if (!packet || pageCount === 0) return null;

  return (
    <div className="mb-12">
      <h2 className="text-xl font-bold uppercase tracking-widest border-b-2 border-black pb-2 mb-6">Manufacturer Specifications</h2>
      <div className="space-y-8">
        {Array.from({ length: pageCount }).map((_, i) => (
          <PublicPacketPage key={i} token={token} pageNumber={i + 1} documentVersion={documentVersion} onLoad={() => handlePageLoad(i + 1)} onError={() => setImageError(true)} />
        ))}
      </div>
    </div>
  );
}

function PublicPacketPage({ token, pageNumber, documentVersion, onLoad, onError }: { token: string, pageNumber: number, documentVersion: string, onLoad: () => void, onError: () => void }) {
  const { data: blob, isLoading, isError } = useGetPublicManufacturerPacketPage(token, pageNumber, { documentVersion });
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    if (isError) onError();
  }, [isError, onError]);

  useEffect(() => {
    if (blob) {
      const u = URL.createObjectURL(blob);
      setUrl(u);
      return () => URL.revokeObjectURL(u);
    }
    return undefined;
  }, [blob]);

  if (isError) return <div className="h-64 bg-red-50 flex items-center justify-center text-red-500 rounded border border-red-200">Failed to load page</div>;
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

  const handleManifestStateChange = React.useCallback((newState: { hasManifest: boolean, isReady: boolean, error?: string }) => {
    setManifestState(prev =>
      prev.hasManifest === newState.hasManifest && prev.isReady === newState.isReady && prev.error === newState.error
        ? prev
        : newState
    );
  }, []);

  const { data: detail, isLoading, isError } = useGetPublicSignoff(token ?? "", {
    query: { enabled: !!token, queryKey: getGetPublicSignoffQueryKey(token ?? "") },
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
        onError: (err: any) => {
          const stale = err?.status === 409;
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
            disabled={!manifestState.isReady || !!manifestState.error}
            title="Print this document, or choose Save as PDF in the print dialog."
            className="bg-black text-white hover:bg-gray-800"
          >
            <Printer className="w-4 h-4 mr-2" /> Print / Save PDF
          </Button>
        </div>
        <div className="mb-6 rounded-md border border-amber-300 bg-amber-50 p-4 text-sm text-amber-950 print:hidden">
          <p><strong>{legacyApproval ? "Historical signature notice:" : "Current review document:"}</strong> this HTML page shows the current quote content and is not proof of an earlier signature. Only an immutable signed PDF is approval evidence.</p>
          {legacyApproval?.documentAvailable ? (
            <>
              <p className="mt-2">This page is read-only and cannot replace the historical approval.</p>
              <a className="mt-2 inline-block font-bold underline" href={`/api/public/signoff/${token}/document`} target="_blank" rel="noreferrer">
                Open original signed PDF evidence
              </a>
            </>
          ) : legacyApproval ? (
            <p className="mt-2 text-xs">
              This page is read-only and cannot replace the historical approval. The historical signature is {legacyApproval.validity === "needs_resigning" ? "no longer current and " : ""}recorded, but its immutable original PDF is unavailable. This metadata is not approval evidence for the current document.
            </p>
          ) : null}
        </div>
        <SignoffDocument
          quote={quote}
          revisions={revisions}
          signoff={null}
          isSigned={false}
          onSubmit={submitSignoff}
          hasManifest={manifestState.hasManifest}
          disabledReason={disabledReason}
          packetSection={<PublicPacketViewer key={detail.documentVersion} token={token!} documentVersion={detail.documentVersion} onStateChange={handleManifestStateChange} />}
        />
      </div>
    </div>
  );
}
