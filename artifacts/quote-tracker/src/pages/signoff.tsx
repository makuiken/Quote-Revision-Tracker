import React, { useState, useEffect } from "react";
import { useParams, Link } from "wouter";
import { ArrowLeft, Printer, Share2, Copy, Mail, Check } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetQuote,
  getGetQuoteQueryKey,
  useSaveSignoff,
  useGetShareInfo,
  getGetShareInfoQueryKey,
  useCreateShareLink,
  useSetRevisionSignoffExclusion,
  useGetManufacturerPacketManifest,
  useGetManufacturerPacketPage,
  getGetSignedSignoffDocumentUrl,
  getGetUnsignedSignoffDocumentUrl,
  type Revision,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/components/ui/toaster";
import { SignoffDocument } from "@/components/signoff-document";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";

function ShareDialog({
  open,
  onOpenChange,
  quoteId,
  quoteNumber,
  customerName,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  quoteId: number;
  quoteNumber: string;
  customerName: string;
}) {
  const [email, setEmail] = useState("");
  const [copied, setCopied] = useState(false);
  const [token, setToken] = useState<string | null>(null);

  const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");
  const { data: shareInfo } = useGetShareInfo({
    query: { queryKey: getGetShareInfoQueryKey(), enabled: open },
  });
  const createShareLink = useCreateShareLink();

  // Generate (or fetch the existing) public share token when the dialog opens
  useEffect(() => {
    if (open && !token && !createShareLink.isPending) {
      createShareLink.mutate(
        { id: quoteId },
        { onSuccess: (data) => setToken(data.token) },
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Public customer link: no login required, token-gated
  const shareOrigin = shareInfo?.publicOrigin ?? window.location.origin;
  const shareUrl = token ? `${shareOrigin}${basePath}/sign/${token}` : null;

  const subject = encodeURIComponent(`Signoff Document – Quote #${quoteNumber}`);
  const body = shareUrl
    ? encodeURIComponent(
        `Hi ${customerName},\n\nPlease review and sign your quote document (Quote #${quoteNumber}) using the link below:\n\n${shareUrl}\n\nIf you have any questions, don't hesitate to reach out.\n\nThank you,\nKuiken Brothers`
      )
    : "";

  const mailtoHref = `mailto:${email}?subject=${subject}&body=${body}`;

  const handleCopyLink = async () => {
    if (!shareUrl) return;
    try {
      await navigator.clipboard.writeText(shareUrl);
    } catch {
      const el = document.createElement("textarea");
      el.value = shareUrl;
      document.body.appendChild(el);
      el.select();
      document.execCommand("copy");
      document.body.removeChild(el);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="font-serif text-xl uppercase tracking-widest">
            Share Signoff Document
          </DialogTitle>
          <DialogDescription>
            Send the signing link for <strong>Quote #{quoteNumber}</strong> to the customer.
            No account or login is needed — anyone with the link can view and sign.
          </DialogDescription>
        </DialogHeader>

        {/* Copy link section */}
        <div className="space-y-2">
          <Label className="text-xs font-bold uppercase tracking-widest text-gray-500">
            Customer Signing Link
          </Label>
          <div className="flex gap-2">
            <Input
              readOnly
              value={shareUrl ?? "Generating link..."}
              className="font-mono text-xs bg-gray-50"
              onClick={(e) => (e.target as HTMLInputElement).select()}
            />
            <Button
              type="button"
              variant="outline"
              size="icon"
              onClick={handleCopyLink}
              disabled={!shareUrl}
              className="shrink-0"
              title="Copy link"
            >
              {copied ? <Check className="w-4 h-4 text-green-600" /> : <Copy className="w-4 h-4" />}
            </Button>
          </div>
        </div>

        <div className="relative my-2">
          <div className="absolute inset-0 flex items-center">
            <span className="w-full border-t border-gray-200" />
          </div>
          <div className="relative flex justify-center text-xs uppercase">
            <span className="bg-white px-2 text-gray-400 font-bold tracking-widest">or email</span>
          </div>
        </div>

        {/* Email section */}
        <div className="space-y-3">
          <div className="space-y-2">
            <Label htmlFor="share-email" className="text-xs font-bold uppercase tracking-widest text-gray-500">
              Customer Email
            </Label>
            <Input
              id="share-email"
              type="email"
              placeholder="customer@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="bg-white"
            />
          </div>
          <Button
            asChild
            className="w-full bg-black text-white hover:bg-gray-800"
            disabled={!shareUrl}
          >
            <a href={shareUrl ? mailtoHref : undefined} aria-disabled={!shareUrl}>
              <Mail className="w-4 h-4 mr-2" />
              Open in Email Client
            </a>
          </Button>
          <p className="text-xs text-gray-500 text-center">
            Opens your default email app with the link and message pre-filled.
          </p>
        </div>
      </DialogContent>
    </Dialog>
  );
}


function InternalPacketViewer({ quoteId, documentVersion, onStateChange }: { quoteId: number, documentVersion: string, onStateChange: (state: { hasManifest: boolean, isReady: boolean, error?: string }) => void }) {
  const { data: manifest, isLoading, isFetching, isError } = useGetManufacturerPacketManifest(quoteId, { documentVersion });

  const pageCount = manifest?.entries.length || 0;
  const [loadedPages, setLoadedPages] = useState<Set<number>>(new Set());
  const [imageError, setImageError] = useState(false);

  useEffect(() => {
    setLoadedPages(new Set());
    setImageError(false);
  }, [manifest]);

  useEffect(() => {
    if (isLoading || isFetching) {
      onStateChange({ hasManifest: false, isReady: false });
    } else if (isError || imageError) {
      onStateChange({ hasManifest: pageCount > 0, isReady: false, error: "One or more packet images failed to load. Please refresh the page." });
    } else if (pageCount > 0) {
      onStateChange({ hasManifest: true, isReady: loadedPages.size === pageCount });
    } else {
      onStateChange({ hasManifest: false, isReady: true });
    }
  }, [isLoading, isFetching, isError, imageError, pageCount, loadedPages.size, onStateChange]);

  const handlePageLoad = (pageOrder: number) => {
    setLoadedPages(prev => {
      const next = new Set(prev);
      next.add(pageOrder);
      return next;
    });
  };

  if (!manifest || manifest.entries.length === 0) return null;

  return (
    <div className="mb-12">
      <h2 className="text-xl font-bold uppercase tracking-widest border-b-2 border-black pb-2 mb-6">Manufacturer Specifications</h2>
      <div className="space-y-8">
        {manifest.entries.sort((a, b) => a.pageOrder - b.pageOrder).map((entry) => (
          <InternalPacketPage key={`${documentVersion}:${entry.pageOrder}`} documentVersion={documentVersion} quoteId={quoteId} packetId={entry.packetId} pageNumber={entry.pageNumber} onLoad={() => handlePageLoad(entry.pageOrder)} onError={() => setImageError(true)} />
        ))}
      </div>
    </div>
  );
}

function InternalPacketPage({ quoteId, packetId, pageNumber, documentVersion, onLoad, onError }: { quoteId: number, packetId: number, pageNumber: number, documentVersion: string, onLoad: () => void, onError: () => void }) {
  const { data: blob, isLoading, isError } = useGetManufacturerPacketPage(quoteId, packetId, pageNumber, { documentVersion });
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

export default function SignoffPage() {
  const { id } = useParams();
  const quoteId = parseInt(id || "0", 10);
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data: detail, isLoading } = useGetQuote(quoteId, { 
    query: { enabled: !!quoteId, queryKey: getGetQuoteQueryKey(quoteId) } 
  });
  
  const saveSignoff = useSaveSignoff();
  const setExclusion = useSetRevisionSignoffExclusion();
  const [shareOpen, setShareOpen] = useState(false);
  const [pendingToggle, setPendingToggle] = useState<Revision | null>(null);
  const [manifestState, setManifestState] = useState<{ hasManifest: boolean; isReady: boolean; error?: string }>({ hasManifest: false, isReady: false });

  const handleManifestStateChange = React.useCallback((newState: { hasManifest: boolean, isReady: boolean, error?: string }) => {
    setManifestState(prev =>
      prev.hasManifest === newState.hasManifest && prev.isReady === newState.isReady && prev.error === newState.error
        ? prev
        : newState
    );
  }, []);

  const toggleExclude = (revision: Revision) => {
    // Changing what appears on a signed document invalidates the signature —
    // confirm with the user before proceeding.
    if (detail?.quote.signed) {
      setPendingToggle(revision);
      return;
    }
    executeToggle(revision);
  };

  const executeToggle = (revision: Revision) => {
    setExclusion.mutate(
      {
        id: quoteId,
        revisionId: revision.id,
        data: { excludedFromSignoff: !revision.excludedFromSignoff },
      },
      {
        onSuccess: (updated) => {
          setPendingToggle(null);
          queryClient.invalidateQueries({ queryKey: getGetQuoteQueryKey(quoteId) });
          toast({
            title: updated.excludedFromSignoff ? "Hidden from signoff" : "Included on signoff",
            description: updated.excludedFromSignoff
              ? "The revision stays in the full log but won't appear on the signoff document."
              : "The revision will appear on the signoff document again.",
          });
        },
        onError: () => {
          toast({ title: "Error", description: "Failed to update the revision.", variant: "destructive" });
        },
      },
    );
  };

  if (isLoading) {
    return <div className="p-8 text-center text-muted-foreground">Loading...</div>;
  }

  if (!detail) {
    return <div className="p-8 text-center text-destructive">Quote not found.</div>;
  }

  const { quote, revisions, signoff } = detail;

  const submitSignoff = (
    signerName: string,
    stakeholderRole: "Homeowner" | "Contractor" | "Architect/Designer" | "Other",
    type: "typed" | "drawn",
    data: string,
  ) => {
    saveSignoff.mutate({ 
      id: quoteId, 
      data: {
        customerName: signerName,
        stakeholderRole,
        signatureType: type,
        signatureData: data,
        documentVersion: detail.documentVersion,
      } 
    }, {
      onSuccess: () => {
        toast({ title: "Signoff Saved", description: "The document has been successfully signed." });
        queryClient.invalidateQueries({ queryKey: getGetQuoteQueryKey(quoteId) });
      },
      onError: (err: any) => {
        const stale = err?.status === 409;
        toast({
          title: stale ? "Document Changed" : "Error",
          description: stale
            ? "This document was updated since it was loaded. It has been refreshed — please review and sign again."
            : "Failed to save signoff.",
          variant: "destructive",
        });
        if (stale) queryClient.invalidateQueries({ queryKey: getGetQuoteQueryKey(quoteId) });
      }
    });
  };

  const disabledReason = manifestState.error
    ? manifestState.error
    : (!manifestState.isReady ? "Loading manufacturer packet specifications..." : undefined);

  return (
    <div className="min-h-[100dvh] bg-gray-100 text-black font-sans print:bg-white print:p-0">
      <div className="max-w-4xl mx-auto p-4 sm:p-8 print:p-0">
        
        {/* Screen-only controls */}
        <div className="print:hidden flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-8 pb-4 border-b-2 border-gray-300">
          <Button asChild variant="ghost" className="text-gray-600 hover:text-black hover:bg-gray-200">
            <Link href={`/quotes/${quote.id}`}>
              <ArrowLeft className="w-4 h-4 mr-2" /> Back to Quote
            </Link>
          </Button>
          <div className="flex gap-3">
            <Button
              variant="outline"
              onClick={() => setShareOpen(true)}
              className="border-gray-300 text-gray-700 hover:bg-gray-100"
            >
              <Share2 className="w-4 h-4 mr-2" /> Share
            </Button>
            <Button asChild className="bg-black text-white hover:bg-gray-800">
              <a href={quote.signed ? getGetSignedSignoffDocumentUrl(quote.id) : getGetUnsignedSignoffDocumentUrl(quote.id)} target="_blank" rel="noopener noreferrer">
                <Printer className="w-4 h-4 mr-2" /> Download PDF
              </a>
            </Button>
          </div>
        </div>

        <SignoffDocument
          quote={quote}
          revisions={revisions}
          signoff={signoff ?? null}
          onSubmit={submitSignoff}
          onToggleExclude={toggleExclude}
          hasManifest={manifestState.hasManifest}
          disabledReason={disabledReason}
          packetSection={<InternalPacketViewer key={detail.documentVersion} quoteId={quoteId} documentVersion={detail.documentVersion} onStateChange={handleManifestStateChange} />}
        />
      </div>

      <ShareDialog
        open={shareOpen}
        onOpenChange={setShareOpen}
        quoteId={quote.id}
        quoteNumber={quote.quoteNumber}
        customerName={quote.customerName}
      />

      <Dialog open={!!pendingToggle} onOpenChange={(open) => !open && setPendingToggle(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="text-destructive">Warning: Signature Removal</DialogTitle>
            <DialogDescription className="text-base text-foreground mt-4">
              This quote is already signed. Changing which revisions appear on the signoff document will remove the customer's signature, and the quote will need to be signed off again.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="mt-6">
            <Button variant="outline" onClick={() => setPendingToggle(null)}>Cancel</Button>
            <Button
              variant="destructive"
              onClick={() => pendingToggle && executeToggle(pendingToggle)}
              disabled={setExclusion.isPending}
            >
              {setExclusion.isPending ? "Saving..." : "Remove Signature & Continue"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
