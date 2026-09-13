import React, { useEffect, useState } from "react";
import { Printer, ArrowLeft, Copy, Check } from "lucide-react";
import { useParams, Link } from "wouter";
import { useAuth } from "@clerk/react";
import {
  getGetPublicScopedManufacturerPacketPageQueryKey,
  getGetPublicScopedManufacturerPacketQueryKey,
  getGetPublicScopedSignoffQueryKey,
  useGetPublicScopedManufacturerPacket,
  useGetPublicScopedManufacturerPacketPage,
  useGetPublicScopedSignoff,
  useSavePublicScopedSignoff,
  useGetCurrentUser,
  getGetCurrentUserQueryKey,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toaster";
import { SignoffDocument } from "@/components/signoff-document";
import { copyTextToClipboard } from "@/lib/copy-text";

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
  const { data: blob, isLoading, isError } = useGetPublicScopedManufacturerPacketPage(token, pageNumber, {
    documentVersion,
  }, {
    query: {
      retry: false,
      queryKey: getGetPublicScopedManufacturerPacketPageQueryKey(token, pageNumber, { documentVersion }),
    },
  });
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    if (isError) onError();
  }, [isError, onError]);
  useEffect(() => {
    if (!blob) return;
    const nextUrl = URL.createObjectURL(blob);
    setUrl(nextUrl);
    return () => URL.revokeObjectURL(nextUrl);
  }, [blob]);

  if (isError) return <div className="h-64 rounded border border-red-200 bg-red-50 flex items-center justify-center text-red-600">Unable to load this approved manufacturer page.</div>;
  if (isLoading || !url) return <div className="h-64 rounded border border-gray-200 bg-gray-100 animate-pulse" />;
  return <img src={url} alt={`Approved manufacturer page ${pageNumber}`} className="block h-auto w-full" onLoad={onLoad} onError={onError} />;
}

function ScopedPacketViewer({
  token,
  documentVersion,
  onStateChange,
}: {
  token: string;
  documentVersion: string;
  onStateChange: (state: { hasManifest: boolean; isReady: boolean; error?: string }) => void;
}) {
  const { data: packet, isLoading, isError } = useGetPublicScopedManufacturerPacket(token, {
    query: {
      retry: false,
      queryKey: getGetPublicScopedManufacturerPacketQueryKey(token),
    },
  });
  const [loaded, setLoaded] = useState<Set<number>>(new Set());
  const [imageError, setImageError] = useState(false);
  const pageCount = packet?.pageCount ?? 0;

  useEffect(() => {
    setLoaded(new Set());
    setImageError(false);
  }, [documentVersion, pageCount]);
  useEffect(() => {
    if (isLoading) onStateChange({ hasManifest: false, isReady: false });
    else if (isError || imageError) onStateChange({ hasManifest: pageCount > 0, isReady: false, error: "One or more approved manufacturer pages could not be loaded. Refresh the page before signing." });
    else if (pageCount) onStateChange({ hasManifest: true, isReady: loaded.size === pageCount });
    else onStateChange({ hasManifest: false, isReady: true });
  }, [imageError, isError, isLoading, loaded.size, onStateChange, pageCount]);

  if (!packet || pageCount === 0) return null;
  return (
    <section className="mb-12">
      <h2 className="mb-2 border-b-2 border-black pb-2 text-xl font-bold uppercase tracking-widest">Approved manufacturer specifications</h2>
      <p className="mb-6 text-sm text-gray-600">Only the manufacturer pages assigned to the approval scope are included below.</p>
      <div className="space-y-8">
        {Array.from({ length: pageCount }, (_, index) => (
          <div key={index + 1} className="overflow-hidden rounded border border-gray-300 bg-white shadow-sm">
            <ScopedPacketPage
              token={token}
              pageNumber={index + 1}
              documentVersion={documentVersion}
              onLoad={() => setLoaded((current) => new Set(current).add(index + 1))}
              onError={() => setImageError(true)}
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
  const [linkCopied, setLinkCopied] = useState(false);
  const [manifestState, setManifestState] = useState<{ hasManifest: boolean; isReady: boolean; error?: string }>({ hasManifest: false, isReady: false });
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
  const isEmployee = dbUser?.status === "approved";
  const copyShareLink = async () => {
    await copyTextToClipboard(window.location.href);
    setLinkCopied(true);
    toast({ title: "Link copied", description: "The customer approval link is ready to share." });
    window.setTimeout(() => setLinkCopied(false), 2000);
  };

  if (isLoading) return <div className="flex min-h-[100dvh] items-center justify-center bg-gray-100 text-gray-600">Loading approval document…</div>;
  if (isError || !detail) {
    return <div className="flex min-h-[100dvh] items-center justify-center bg-gray-100 p-8"><div className="max-w-md rounded-lg border border-gray-200 bg-white p-8 text-center shadow-lg"><h1 className="mb-2 font-serif text-xl font-bold">Link Not Valid</h1><p className="text-gray-600">This approval link is invalid or no longer active. Please contact your Kuiken Brothers representative.</p></div></div>;
  }

  const signed = detail.status === "signed";
  const signoff = detail.signoff ?? null;
  if (signed !== Boolean(signoff)) {
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
              <Button variant="outline" onClick={copyShareLink} className="border-gray-300 bg-white text-gray-800 hover:bg-gray-50">
                {linkCopied ? <Check className="mr-2 h-4 w-4 text-green-700" /> : <Copy className="mr-2 h-4 w-4" />}
                {linkCopied ? "Link Copied" : "Copy Share Link"}
              </Button>
            )}
            <Button onClick={() => window.print()} disabled={Boolean(disabledReason)} className="bg-black text-white hover:bg-gray-800" title="Print this exact approval document or choose Save as PDF.">
              <Printer className="mr-2 h-4 w-4" /> Print / Save PDF
            </Button>
          </div>
        </div>
        <SignoffDocument
          quote={detail.quote}
          revisions={detail.revisions}
          signoff={signoff}
          isSigned={signed}
          productTypes={detail.productTypes}
          notIncludedProductTypes={detail.notIncludedProductTypes}
          preparedAt={detail.preparedAt}
          hasManifest={manifestState.hasManifest}
          disabledReason={disabledReason}
          packetSection={<ScopedPacketViewer token={token!} documentVersion={detail.documentVersion} onStateChange={onManifestStateChange} />}
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
      </div>
    </div>
  );
}