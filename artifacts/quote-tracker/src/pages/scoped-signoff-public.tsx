import React, { useEffect, useRef, useState } from "react";
import { Printer, ArrowLeft, Copy, Check, Mail } from "lucide-react";
import { useParams, Link } from "wouter";
import { useAuth } from "@clerk/react";
import {
  getGetPublicScopedManufacturerPacketPageQueryKey,
  getGetPublicScopedManufacturerPacketQueryKey,
  getGetPublicScopedSignoffQueryKey,
  getGetShareInfoQueryKey,
  useGetPublicScopedManufacturerPacket,
  useGetPublicScopedManufacturerPacketPage,
  useGetPublicScopedSignoff,
  useGetShareInfo,
  useSavePublicScopedSignoff,
  useGetCurrentUser,
  getGetCurrentUserQueryKey,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/components/ui/toaster";
import { SignoffDocument } from "@/components/signoff-document";
import { SignoffReceiptView } from "@/components/signoff-receipt";
import { copyTextToClipboard } from "@/lib/copy-text";
import { categoryLabel } from "@/lib/revision-categories";

function ScopedPacketPage({
  token,
  pageNumber,
  documentVersion,
  onLoad,
  onError,
}: {
  token: string;
  pageNumber: number;
  documentVersion: string;
  onLoad: () => void;
  onError: () => void;
}) {
  const { data: blob, isLoading, isError, refetch } = useGetPublicScopedManufacturerPacketPage(token, pageNumber, {
    documentVersion,
  }, {
    query: {
      retry: false,
      queryKey: getGetPublicScopedManufacturerPacketPageQueryKey(token, pageNumber, { documentVersion }),
    },
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
    if (!blob) return;
    const nextUrl = URL.createObjectURL(blob);
    setUrl(nextUrl);
    return () => URL.revokeObjectURL(nextUrl);
  }, [blob]);

  if (isError) {
    return (
      <div className="min-h-64 rounded border border-red-200 bg-red-50 flex flex-col gap-3 items-center justify-center text-red-800 p-6" role="alert">
        <p className="font-medium">Approved manufacturer page {pageNumber} could not be loaded.</p>
        <Button type="button" variant="outline" size="sm" onClick={() => refetch()}>
          Retry this page
        </Button>
      </div>
    );
  }
  if (isLoading || !url) return <div className="h-64 rounded border border-gray-200 bg-gray-100 animate-pulse" />;
  return <img src={url} alt={`Approved manufacturer page ${pageNumber}`} className="block h-auto w-full" onLoad={onLoad} onError={onError} />;
}

function ScopedPacketViewer({
  token,
  documentVersion,
  onStateChange,
  fallbackOpened,
  setFallbackOpened,
  allowFallbackForReady = true,
}: {
  token: string;
  documentVersion: string;
  onStateChange: (state: { hasManifest: boolean; isReady: boolean; error?: string }) => void;
  fallbackOpened: boolean;
  setFallbackOpened: (opened: boolean) => void;
  /**
   * Signing can proceed after the customer opens the exact PDF fallback, but
   * a formatted receipt view must never print while packet images are missing.
   */
  allowFallbackForReady?: boolean;
}) {
  const { data: packet, isLoading, isError, error, refetch } = useGetPublicScopedManufacturerPacket(token, {
    query: {
      retry: false,
      queryKey: getGetPublicScopedManufacturerPacketQueryKey(token),
    },
  });
  const [loaded, setLoaded] = useState<Set<number>>(new Set());
  const [failedPages, setFailedPages] = useState<Set<number>>(new Set());
  const [fallbackError, setFallbackError] = useState<string | null>(null);
  const [isOpeningFallback, setIsOpeningFallback] = useState(false);
  const pageCount = packet?.pageCount ?? 0;
  const noPacket = isError && (error as { status?: number } | null)?.status === 404;

  useEffect(() => {
    setLoaded(new Set());
    setFailedPages(new Set());
    setFallbackOpened(false);
    setFallbackError(null);
  }, [documentVersion, pageCount, setFallbackOpened]);

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
      const response = await fetch(`/api/public/scoped-signoff/${token}/document`);
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
      if (fallbackOpened && allowFallbackForReady) {
        onStateChange({ hasManifest: true, isReady: true });
      } else {
        onStateChange({ hasManifest: true, isReady: false, error: "One or more packet images failed to load." });
      }
    } else if (pageCount > 0) {
      onStateChange({ hasManifest: true, isReady: loaded.size === pageCount });
    } else {
      onStateChange({ hasManifest: false, isReady: true });
    }
  }, [isLoading, isError, noPacket, failedPages.size, pageCount, loaded.size, onStateChange, fallbackOpened, allowFallbackForReady]);

  if (noPacket || (!isError && pageCount === 0)) return null;
  return (
    <section className="mb-12">
      <h2 className="mb-2 border-b-2 border-black pb-2 text-xl font-bold uppercase tracking-widest">Approved manufacturer specifications</h2>
      <p className="mb-6 text-sm text-gray-600">Only the manufacturer pages assigned to the approval scope are included below.</p>

      {(isError || failedPages.size > 0) && (
        <div className="mb-6 bg-amber-50 border border-amber-200 text-amber-900 p-4 rounded text-sm space-y-3" role="alert" aria-live="polite">
          <p className="font-bold">Image preview unavailable</p>
          <p>We couldn't load the manufacturer specification images right now. You can retry loading them, or view the exact approval document directly.</p>
          <div className="flex gap-3">
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setLoaded(new Set());
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
        {Array.from({ length: pageCount }, (_, index) => (
          <div key={index + 1} className="overflow-hidden rounded border border-gray-300 bg-white shadow-sm">
            <ScopedPacketPage
              token={token}
              pageNumber={index + 1}
              documentVersion={documentVersion}
              onLoad={() => {
                setLoaded((current) => new Set(current).add(index + 1));
                setFailedPages((current) => {
                  const next = new Set(current);
                  next.delete(index + 1);
                  return next;
                });
              }}
              onError={() => setFailedPages((current) => new Set(current).add(index + 1))}
            />
          </div>
        ))}
      </div>
    </section>
  );
}

export default function ScopedPublicSignoffPage() {
  const { token } = useParams();
  const { toast } = useToast();
  const [shareOpen, setShareOpen] = useState(false);
  const [shareEmail, setShareEmail] = useState("");
  const [linkCopied, setLinkCopied] = useState(false);
  const [manifestState, setManifestState] = useState<{ hasManifest: boolean; isReady: boolean; error?: string }>({ hasManifest: false, isReady: false });
  const [fallbackOpened, setFallbackOpened] = useState(false);
  const [showSignedDocument, setShowSignedDocument] = useState(false);
  const onManifestStateChange = React.useCallback((next: { hasManifest: boolean; isReady: boolean; error?: string }) => {
    setManifestState((current) => current.hasManifest === next.hasManifest && current.isReady === next.isReady && current.error === next.error ? current : next);
  }, []);
  const { data: detail, isLoading, isError, refetch } = useGetPublicScopedSignoff(token ?? "", {
    query: {
      enabled: Boolean(token),
      retry: false,
      queryKey: getGetPublicScopedSignoffQueryKey(token ?? ""),
    },
  });
  const sign = useSavePublicScopedSignoff({
    mutation: {
      onSuccess: () => {
        toast({ title: "Thank you", description: "Your approval has been recorded for the listed product types." });
        refetch();
      },
      onError: (error) => {
        const stale = error.status === 409;
        toast({
          title: stale ? "Document changed" : "Could not save approval",
          description: stale
            ? "The approval content changed while you were reviewing it. The latest scope-bound document has been reloaded; please review it again."
            : error.message,
          variant: "destructive",
        });
        if (stale) refetch();
      },
    },
  });

  const { isSignedIn } = useAuth();
  const { data: dbUser } = useGetCurrentUser({
    query: {
      enabled: Boolean(isSignedIn),
      retry: false,
      queryKey: getGetCurrentUserQueryKey(),
    },
  });
  const { data: shareInfo } = useGetShareInfo({
    query: {
      enabled: shareOpen,
      queryKey: getGetShareInfoQueryKey(),
    },
  });
  const isEmployee = dbUser?.status === "approved";
  const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");
  const shareUrl = `${shareInfo?.publicOrigin ?? window.location.origin}${basePath}/scoped-sign/${token}`;
  const copyShareLink = async () => {
    await copyTextToClipboard(shareUrl);
    setLinkCopied(true);
    window.setTimeout(() => setLinkCopied(false), 2000);
  };

  if (isLoading) return <div className="flex min-h-[100dvh] items-center justify-center bg-gray-100 text-gray-600">Loading approval document…</div>;
  if (isError || !detail) {
    return <div className="flex min-h-[100dvh] items-center justify-center bg-gray-100 p-8"><div className="max-w-md rounded-lg border border-gray-200 bg-white p-8 text-center shadow-lg"><h1 className="mb-2 font-serif text-xl font-bold">Link Not Valid</h1><p className="text-gray-600">This approval link is invalid or no longer active. Please contact your Kuiken Brothers representative.</p></div></div>;
  }

  const signed = detail.status === "signed";
  const signoff = detail.signoff ?? null;
  const receipt = detail.receipt ?? null;
  if (signed && !receipt) {
    return <div className="flex min-h-[100dvh] items-center justify-center bg-gray-100 p-8"><div className="max-w-md rounded-lg border border-gray-200 bg-white p-8 text-center shadow-lg"><h1 className="mb-2 font-serif text-xl font-bold">Approval Record Unavailable</h1><p className="text-gray-600">This approval link returned an inconsistent signing record. Please contact your Kuiken Brothers representative.</p></div></div>;
  }
  const disabledReason = detail.status === "needs_resigning"
    ? "This approval request is no longer current. Contact your Kuiken Brothers representative for a new link."
    : manifestState.error ?? (!manifestState.isReady ? "Loading approved manufacturer specifications…" : undefined);
  return (
    <div className="min-h-[100dvh] bg-gray-100 font-sans text-black print:bg-white print:p-0">
      <div className="mx-auto max-w-4xl p-4 sm:p-8 print:p-0">
        <div className="mb-8 flex justify-between items-center border-b-2 border-gray-300 pb-4 print:hidden">
          <div>
            {isEmployee ? (
              <Button variant="ghost" asChild className="text-gray-600 hover:text-black -ml-4">
                <Link href={`/quotes/${detail.quote.id}/signoff`}>
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
          <div className="flex items-center gap-2">
            {isEmployee && (
              <Button variant="outline" onClick={() => setShareOpen(true)} className="border-gray-300 bg-white text-gray-800 hover:bg-gray-50">
                <Copy className="mr-2 h-4 w-4" />
                Share Link
              </Button>
            )}
             {(!receipt || showSignedDocument) && (
               <>
                 {receipt && showSignedDocument && (
                   <Button
                     type="button"
                     variant="outline"
                     onClick={() => setShowSignedDocument(false)}
                     className="border-gray-300 bg-white text-gray-800 hover:bg-gray-50"
                   >
                     Back to receipt
                   </Button>
                 )}
                 <Button
                   onClick={() => window.print()}
                   disabled={
                     !manifestState.isReady ||
                     Boolean(manifestState.error) ||
                     (!receipt && Boolean(disabledReason))
                   }
                   className="bg-black text-white hover:bg-gray-800"
                   title={manifestState.isReady ? "Print this formatted signed document or choose Save as PDF." : "Wait until every packet page has loaded before printing."}
                 >
                   <Printer className="mr-2 h-4 w-4" /> Print / Save PDF
                 </Button>
               </>
             )}
          </div>
        </div>
        {receipt && !showSignedDocument ? (
          <SignoffReceiptView
            receipt={receipt}
            onViewDocument={() => {
              setManifestState({ hasManifest: false, isReady: false });
              setShowSignedDocument(true);
            }}
          />
        ) : receipt ? (
          <SignoffDocument
            quote={detail.quote}
            revisions={detail.revisions}
            signoff={detail.signoff ?? null}
            isSigned
            productTypes={detail.productTypes}
            notIncludedProductTypes={detail.notIncludedProductTypes}
            preparedAt={detail.preparedAt}
            hasManifest={manifestState.hasManifest}
            packetSection={
              <ScopedPacketViewer
                token={token!}
                documentVersion={detail.documentVersion}
                onStateChange={onManifestStateChange}
                fallbackOpened={fallbackOpened}
                setFallbackOpened={setFallbackOpened}
                allowFallbackForReady={false}
              />
            }
            onSubmit={() => undefined}
          />
        ) : (
          <SignoffDocument
            quote={detail.quote}
            revisions={detail.revisions}
            signoff={null}
            isSigned={false}
            productTypes={detail.productTypes}
            notIncludedProductTypes={detail.notIncludedProductTypes}
            preparedAt={detail.preparedAt}
            hasManifest={manifestState.hasManifest}
            disabledReason={disabledReason}
            isSubmitting={sign.isPending}
            packetSection={<ScopedPacketViewer token={token!} documentVersion={detail.documentVersion} onStateChange={onManifestStateChange} fallbackOpened={fallbackOpened} setFallbackOpened={setFallbackOpened} />}
            onSubmit={(customerName, stakeholderRole, signatureType, signatureData) => sign.mutate({
              token: token!,
              data: {
                customerName,
                stakeholderRole,
                signatureType,
                signatureData,
                documentVersion: detail.documentVersion,
              },
            })}
          />
        )}
        <Dialog open={shareOpen} onOpenChange={setShareOpen}>
          <DialogContent className="sm:max-w-lg">
            <DialogHeader>
              <DialogTitle className="font-serif text-xl font-bold">Share Approval Link</DialogTitle>
              <DialogDescription className="mt-2 text-muted-foreground">
                This link allows the customer to review and approve only the selected products.
              </DialogDescription>
            </DialogHeader>
            <div className="mt-2 rounded-md border border-border bg-muted p-4 text-sm">
              <div className="flex gap-2">
                <Check className="mt-0.5 h-4 w-4 shrink-0 text-green-600" />
                <div>
                  <strong className="mb-0.5 block text-foreground">Included in this link:</strong>
                  <span className="text-foreground">{detail.productTypes.map(categoryLabel).join(", ")}</span>
                </div>
              </div>
              {detail.notIncludedProductTypes.length > 0 && (
                <div className="mt-3 flex gap-2 border-t border-border pt-3">
                  <span className="mt-0.5 h-4 w-4 shrink-0 rounded-full border border-border bg-card" />
                  <div>
                    <strong className="mb-0.5 block text-muted-foreground">Not included:</strong>
                    <span className="text-muted-foreground">{detail.notIncludedProductTypes.map(categoryLabel).join(", ")}</span>
                  </div>
                </div>
              )}
            </div>
            <div className="mt-2 space-y-2">
              <Label htmlFor="preview-share-link">Customer signing link</Label>
              <div className="flex gap-2">
                <Input id="preview-share-link" readOnly value={shareUrl} onClick={(event) => event.currentTarget.select()} className="bg-card text-sm" />
                <Button variant="outline" size="icon" onClick={copyShareLink} title="Copy scope-bound link" className="shrink-0 bg-card">
                  {linkCopied ? <Check className="h-4 w-4 text-green-700" /> : <Copy className="h-4 w-4 text-foreground" />}
                </Button>
              </div>
            </div>
            <div className="mt-4 space-y-2">
              <Label htmlFor="preview-share-email">Customer email</Label>
              <div className="flex gap-2">
                <Input id="preview-share-email" value={shareEmail} onChange={(event) => setShareEmail(event.target.value)} type="email" placeholder="customer@example.com" className="bg-card" />
                <Button asChild className="shrink-0">
                  <a href={`mailto:${shareEmail}?subject=${encodeURIComponent(`Approval requested – Quote #${detail.quote.quoteNumber}`)}&body=${encodeURIComponent(`Hi ${detail.quote.customerName},\n\nPlease review and approve ${detail.productTypes.map(categoryLabel).join(", ")} for Quote #${detail.quote.quoteNumber}.\n\n${shareUrl}\n\nThis link includes only the product types listed above.\n\nThank you,\nKuiken Brothers`)}`}>
                    <Mail className="mr-2 h-4 w-4" /> Open Email
                  </a>
                </Button>
              </div>
            </div>
          </DialogContent>
        </Dialog>
      </div>
    </div>
  );
}