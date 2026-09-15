import { useState } from "react";
import { ArrowLeft, Download, FileText, Printer, ShieldCheck } from "lucide-react";
import { Link, useParams } from "wouter";
import {
  getGetLegacySignatureQueryKey,
  getSignedSignoffDocument,
  useGetLegacySignature,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useToast } from "@/components/ui/toaster";
import { format } from "date-fns";

/**
 * The API validates drawn signatures as canvas PNGs. Keep this second,
 * browser-side guard so a legacy value can never become an arbitrary image
 * URL if a stored row is malformed or a future API response is misconfigured.
 */
function isSafeDrawnSignatureData(value: string): boolean {
  return (
    value.length <= 600_000 &&
    /^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(value)
  );
}

function statusLabel(validity: "signed" | "needs_resigning"): string {
  return validity === "signed" ? "Signed" : "Needs re-signing";
}

export default function LegacySignaturePage() {
  const { id } = useParams();
  const quoteId = Number(id);
  const { toast } = useToast();
  const [isOpeningPdf, setIsOpeningPdf] = useState(false);
  const { data: record, isLoading, isError, error } = useGetLegacySignature(quoteId, {
    query: {
      enabled: Number.isInteger(quoteId) && quoteId > 0,
      retry: false,
      queryKey: getGetLegacySignatureQueryKey(quoteId),
    },
  });

  const openOriginalPdf = async () => {
    if (!record?.signedDocumentAvailable) return;
    const popup = window.open("", "_blank");
    if (!popup) {
      toast({
        title: "Could not open PDF",
        description: "Allow pop-ups for this site, then try again.",
        variant: "destructive",
      });
      return;
    }
    popup.opener = null;
    setIsOpeningPdf(true);
    try {
      const pdf = await getSignedSignoffDocument(record.quoteId, {
        responseType: "blob",
      });
      const objectUrl = URL.createObjectURL(pdf);
      popup.location.href = objectUrl;
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
    } catch (openError) {
      popup.close();
      toast({
        title: "Could not download original signed PDF",
        description:
          openError instanceof Error ? openError.message : "Please try again.",
        variant: "destructive",
      });
    } finally {
      setIsOpeningPdf(false);
    }
  };

  if (isLoading) {
    return (
      <div className="flex min-h-[100dvh] items-center justify-center bg-muted text-muted-foreground">
        Loading legacy signature record…
      </div>
    );
  }

  if (isError || !record) {
    const status = (error as { status?: number } | null)?.status;
    const message =
      status === 401
        ? "Sign in to view this authenticated legacy signature record."
        : status === 403
          ? "Approved staff access is required to view this legacy signature record."
          : status === 404
            ? "The quote or legacy signature record was not found."
            : "The legacy signature record could not be loaded.";
    return (
      <div className="flex min-h-[100dvh] items-center justify-center bg-muted p-6">
        <Card className="w-full max-w-lg border-border">
          <CardHeader>
            <CardTitle className="font-serif text-2xl">Legacy signature record unavailable</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-muted-foreground" role="alert">{message}</p>
            <Button asChild variant="outline">
              <Link href="/quotes">Back to Dashboard</Link>
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  const signedDate = format(new Date(record.signedAt), "MMMM d, yyyy 'at' h:mm a");
  const safeDrawnSignature =
    record.signatureType === "drawn" &&
    record.signatureDataValid &&
    isSafeDrawnSignatureData(record.signatureData);

  return (
    <div className="min-h-[100dvh] bg-muted text-foreground print:bg-white">
      <div className="mx-auto max-w-3xl space-y-6 p-4 sm:p-8 print:p-0">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between print:hidden">
          <div>
            <Button asChild variant="ghost" className="-ml-2 mb-2 text-muted-foreground">
              <Link href={`/quotes/${record.quoteId}`}>
                <ArrowLeft className="mr-1.5 h-4 w-4" /> Back to Quote #{record.quoteNumber}
              </Link>
            </Button>
            <p className="text-sm font-bold uppercase tracking-widest text-muted-foreground">
              Read-only historical evidence
            </p>
            <h1 className="font-serif text-3xl font-extrabold tracking-tight">
              Legacy signature record
            </h1>
          </div>
          <div className="flex gap-2">
            <Button type="button" variant="outline" onClick={() => window.print()}>
              <Printer className="mr-2 h-4 w-4" /> Print record
            </Button>
            {record.signedDocumentAvailable && (
              <Button type="button" onClick={openOriginalPdf} disabled={isOpeningPdf}>
                <Download className="mr-2 h-4 w-4" />
                {isOpeningPdf ? "Opening PDF…" : "Original signed PDF"}
              </Button>
            )}
          </div>
        </div>

        <Card className="border-2 border-amber-200 bg-card shadow-sm print:border-black print:shadow-none">
          <CardHeader className="border-b border-border print:border-black">
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="text-xs font-bold uppercase tracking-[0.2em] text-muted-foreground">
                  Kuiken Brothers
                </p>
                <CardTitle className="mt-2 font-serif text-3xl">
                  Legacy signature record
                </CardTitle>
                <p className="mt-2 text-sm text-muted-foreground">
                  Original stored signature evidence — read-only
                </p>
              </div>
              <ShieldCheck className="h-10 w-10 shrink-0 text-amber-600" aria-hidden="true" />
            </div>
          </CardHeader>
          <CardContent className="space-y-8 p-6 sm:p-8">
            <section aria-labelledby="legacy-record-identifiers">
              <h2 id="legacy-record-identifiers" className="mb-3 text-sm font-bold uppercase tracking-widest text-muted-foreground">
                Original record identifiers
              </h2>
              <dl className="grid gap-3 rounded-lg border border-border bg-muted/40 p-4 sm:grid-cols-3">
                <div>
                  <dt className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Quote number</dt>
                  <dd className="mt-1 font-serif text-xl font-bold">#{record.quoteNumber}</dd>
                </div>
                <div>
                  <dt className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Quote ID</dt>
                  <dd className="mt-1 font-mono text-sm">{record.quoteId}</dd>
                </div>
                <div>
                  <dt className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Signoff record ID</dt>
                  <dd className="mt-1 font-mono text-sm">{record.id}</dd>
                </div>
              </dl>
            </section>

            <section aria-labelledby="original-signer">
              <h2 id="original-signer" className="mb-3 text-sm font-bold uppercase tracking-widest text-muted-foreground">
                Original signer
              </h2>
              <dl className="grid gap-4 rounded-lg border border-border p-4 sm:grid-cols-3">
                <div>
                  <dt className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Name</dt>
                  <dd className="mt-1 font-semibold">{record.signerName}</dd>
                </div>
                <div>
                  <dt className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Role</dt>
                  <dd className="mt-1 font-semibold">{record.signerRole}</dd>
                </div>
                <div>
                  <dt className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Original signed date</dt>
                  <dd className="mt-1 font-semibold">{signedDate}</dd>
                </div>
              </dl>
            </section>

            <section aria-labelledby="original-signature">
              <h2 id="original-signature" className="mb-3 text-sm font-bold uppercase tracking-widest text-muted-foreground">
                Original signature
              </h2>
              <div className="flex min-h-36 items-center justify-center rounded-lg border-2 border-black bg-white p-6">
                {record.signatureType === "typed" ? (
                  <span className="break-words text-center font-serif text-4xl italic">
                    {record.signatureData}
                  </span>
                ) : safeDrawnSignature ? (
                  <img
                    src={record.signatureData}
                    alt="Original drawn signature"
                    className="max-h-32 max-w-full object-contain"
                  />
                ) : (
                  <p className="text-center text-sm text-muted-foreground">
                    The stored drawn signature could not be safely rendered.
                  </p>
                )}
              </div>
              <p className="mt-2 text-center text-xs font-bold uppercase tracking-widest text-muted-foreground">
                {record.signatureType === "typed" ? "Original typed signature" : "Original drawn signature"}
              </p>
            </section>

            <section aria-labelledby="legacy-validity" className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-amber-950">
              <h2 id="legacy-validity" className="text-sm font-bold uppercase tracking-widest">
                Current legacy validity
              </h2>
              <p className="mt-2 text-lg font-bold">{statusLabel(record.validity)}</p>
              {record.invalidationReason && (
                <p className="mt-2 text-sm">
                  <span className="font-bold">Reason:</span> {record.invalidationReason}
                </p>
              )}
              <p className="mt-3 text-xs leading-relaxed">
                This is the current validity of the legacy record, separate from
                the original signature and its original signed date.
              </p>
            </section>

            <section aria-labelledby="original-document" className="border-t border-border pt-6 print:border-black">
              <h2 id="original-document" className="text-sm font-bold uppercase tracking-widest text-muted-foreground">
                Original full-document PDF
              </h2>
              {record.signedDocumentAvailable ? (
                <>
                  <p className="mt-2 text-sm leading-relaxed">
                    The original signed PDF is preserved separately as authenticated
                    evidence and is not replaced by this printable record.
                  </p>
                  <Button type="button" variant="outline" className="mt-4 print:hidden" onClick={openOriginalPdf} disabled={isOpeningPdf}>
                    <FileText className="mr-2 h-4 w-4" />
                    {isOpeningPdf ? "Opening PDF…" : "Download original signed PDF"}
                  </Button>
                </>
              ) : (
                <p className="mt-2 text-sm leading-relaxed">
                  The original full-document PDF was not saved for this legacy
                  signature record. No signed document can be reconstructed.
                </p>
              )}
            </section>

            <p className="border-t border-border pt-6 text-xs leading-relaxed text-muted-foreground print:border-black">
              This printable record contains only the original stored signature
              fields and record identifiers. It intentionally omits today&apos;s
              quote specifications and revision history and must not be treated
              as a signed copy of current quote content.
            </p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}