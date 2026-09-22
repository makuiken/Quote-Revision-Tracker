import { useState, useRef, useEffect, useMemo, useCallback } from "react";
import { useParams, Link } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Upload, FileText, Loader2, AlertTriangle, CheckCircle, RotateCcw, ZoomIn, ZoomOut, Save, X, Trash2, FileImage, LayoutList } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { Shell } from "@/components/layout";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { useToast } from "@/components/ui/toaster";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { categoryLabel } from "@/lib/revision-categories";
import {
  useGetQuote,
  getGetQuoteQueryKey,
  useGetCurrentUser,
  useListManufacturerPackets,
  getListManufacturerPacketsQueryKey,
  useRequestManufacturerPacketUpload,
  useCompleteManufacturerPacketUpload,
  useSetManufacturerPacketRedactions,
  useRetryManufacturerPacket,
  useGetManufacturerPacketPage,
  getManufacturerPacketPage,
  getGetManufacturerPacketPageQueryKey,
  useGetManufacturerPacketSourcePage,
  getManufacturerPacketSourcePage,
  getGetManufacturerPacketSourcePageQueryKey,
  useGetManufacturerPacketManifest,
  getGetManufacturerPacketManifestQueryKey,
  useSetManufacturerPacketManifest,
  useClearManufacturerPacketManifest,
  useDeleteManufacturerPacket,
  useSetManufacturerPacketProductType,
  useSetManufacturerPacketManufacturer,
  useListManufacturerRedactionTemplateOptions,
  getListManufacturerRedactionTemplateOptionsQueryKey,
  type ManufacturerPacket,
  type ManufacturerRedactionTemplateOption,
  type QuoteCategoriesItem,
  type PacketPageAnalysis,
  type PacketRect,
  type Quote
} from "@workspace/api-client-react";
import { Input } from "@/components/ui/input";
import { PreviewFetchScheduler, redactionFromDrag } from "@/lib/preview-fetch-scheduler";

type ProductType = QuoteCategoriesItem;

export function canonicalManufacturer(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US");
}

export type TemplateFeedbackCode = "no_active_match" | "layout_incompatible";
const PROCESSING_SLOW_AFTER_MS = 2 * 60 * 1000;
const PROCESSING_POLL_STOP_AFTER_MS = 6 * 60 * 1000;
const PREVIEW_FETCH_CONCURRENCY = 2;
const previewFetchScheduler = new PreviewFetchScheduler(PREVIEW_FETCH_CONCURRENCY);

function usePreviewVisibility<T extends HTMLElement>(allowed = true) {
  const ref = useRef<T>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const element = ref.current;
    if (!allowed || !element) {
      setVisible(false);
      return;
    }
    if (typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return;
    }
    let root = element.parentElement;
    while (root && !/(auto|scroll)/.test(getComputedStyle(root).overflowY)) {
      root = root.parentElement;
    }
    const observer = new IntersectionObserver(
      ([entry]) => setVisible(entry.isIntersecting),
      { root, rootMargin: "160px" },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [allowed]);

  return { ref, visible: allowed && visible };
}

function packetProcessingAgeMs(
  packet: Pick<ManufacturerPacket, "updatedAt">,
  now = Date.now(),
): number {
  const updatedAt = Date.parse(String(packet.updatedAt));
  return Number.isFinite(updatedAt) ? Math.max(0, now - updatedAt) : 0;
}

export function packetProcessingPollInterval(
  packets: readonly ManufacturerPacket[] | undefined,
  now = Date.now(),
  observations?: Map<number, { fingerprint: string; advancedAt: number }>,
): number | false {
  const pending = packets?.filter(
    (packet) => packet.status === "queued" || packet.status === "processing",
  ) ?? [];
  if (!pending.length) return false;
  if (observations) {
    const pendingIds = new Set(pending.map(packet => packet.id));
    for (const id of observations.keys()) if (!pendingIds.has(id)) observations.delete(id);
  }
  const youngestAge = Math.min(
    ...pending.map((packet) => {
      const age = packetProcessingAgeMs(packet, now);
      if (!observations || !packet.processingProgress) return age;
      const fingerprint = JSON.stringify(packet.processingProgress);
      const previous = observations.get(packet.id);
      const advancedAt = previous && previous.fingerprint !== fingerprint
        ? now
        : previous?.advancedAt ?? now - age;
      observations.set(packet.id, { fingerprint, advancedAt });
      return Math.min(age, Math.max(0, now - advancedAt));
    }),
  );
  if (youngestAge >= PROCESSING_POLL_STOP_AFTER_MS) return false;
  return youngestAge >= PROCESSING_SLOW_AFTER_MS ? 15_000 : 2_000;
}

export function parseTemplateFeedback(
  value: string | null | undefined,
): { code: TemplateFeedbackCode; message: string } | null {
  const match = value?.match(
    /^\[template:(no_active_match|layout_incompatible)\]\s*(.*)$/,
  );
  if (!match) return null;
  return {
    code: match[1] as TemplateFeedbackCode,
    message: match[2] || "Manual review is required.",
  };
}

export function deduplicateManufacturerOptions(
  options: readonly ManufacturerRedactionTemplateOption[],
): ManufacturerRedactionTemplateOption[] {
  const seen = new Set<string>();
  return options.filter((option) => {
    const key = `${option.productType}:${canonicalManufacturer(option.manufacturer)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function cleanedManufacturerPacketPreviewQueryKey(
  quoteId: number,
  packetId: number,
  pageNumber: number,
  revision: string,
) {
  return [
    ...getGetManufacturerPacketPageQueryKey(
      quoteId,
      packetId,
      pageNumber,
      undefined,
    ),
    "revision",
    revision,
  ] as const;
}

export default function ManufacturerPacketsPage() {
  const { id } = useParams();
  const quoteId = parseInt(id || "0", 10);

  return (
    <Shell>
      <div className="mb-6">
        <Button asChild variant="ghost" className="-ml-2 text-muted-foreground hover:text-foreground mb-2">
          <Link href={`/quotes/${quoteId}`}>
            <ArrowLeft className="w-4 h-4 mr-1.5" /> Back to Quote
          </Link>
        </Button>
        <h1 className="text-3xl font-extrabold tracking-tight text-foreground">Manufacturer Quotes</h1>
        <p className="text-muted-foreground font-medium mt-1">Upload, clean up, and publish manufacturer pages for customer review.</p>
      </div>
      <PacketsManager quoteId={quoteId} />
    </Shell>
  );
}

function PacketsManager({ quoteId }: { quoteId: number }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const progressObservations = useRef(new Map<number, { fingerprint: string; advancedAt: number }>());
  const {
    data: packetData = [],
    isLoading,
    isError,
    refetch: refetchPackets,
  } = useListManufacturerPackets(quoteId, {
    query: {
      queryKey: getListManufacturerPacketsQueryKey(quoteId),
      refetchOnMount: "always",
      refetchOnWindowFocus: true,
      refetchInterval: (query) =>
        packetProcessingPollInterval(query.state.data, Date.now(), progressObservations.current),
    }
  });
  const packets = packetData;

  const {
    data: quoteDetail,
    isLoading: isQuoteLoading,
    isFetching: isQuoteFetching,
    isError: isQuoteError,
  } = useGetQuote(quoteId, {
    query: {
      queryKey: getGetQuoteQueryKey(quoteId),
      refetchOnMount: "always",
      refetchOnWindowFocus: true,
    },
  });
  const quote = quoteDetail?.quote;

  const [activePacketId, setActivePacketId] = useState<number | 'manifest' | null>(null);
  const [editingManufacturerPacketId, setEditingManufacturerPacketId] = useState<number | null>(null);
  const [manufacturerEditValue, setManufacturerEditValue] = useState("");

  useEffect(() => {
    if (packets.length > 0 && !activePacketId) {
      const pending = packets.find(p => p.status === "needs_review" || p.status === "ready_for_approval");
      if (pending) setActivePacketId(pending.id);
      else setActivePacketId('manifest');
    } else if (packets.length === 0 && !activePacketId) {
      setActivePacketId('manifest');
    }
  }, [packets, activePacketId]);

  const activePacket = typeof activePacketId === 'number' ? packets.find(p => p.id === activePacketId) || null : null;

  const nextStep = packets.length === 0
    ? "Upload the first manufacturer quote PDF."
    : packets.some(packet => packet.status === "needs_review")
      ? "Review and redact the quote, then generate a clean preview."
      : packets.some(packet => packet.status === "awaiting_upload" || packet.status === "queued" || packet.status === "processing")
        ? "Wait for the manufacturer quote to finish processing, then review it."
      : packets.some(packet => packet.status === "ready_for_approval")
        ? "Review the clean preview and add the pages to the customer package."
        : packets.some(packet => packet.status === "approved")
          ? "Ensure all pages are in the customer package, then proceed to signoff."
          : "Review the manufacturer quote status and try again if processing failed.";

  const deletePacket = useDeleteManufacturerPacket();
  const updateProductType = useSetManufacturerPacketProductType({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListManufacturerPacketsQueryKey(quoteId) });
        queryClient.invalidateQueries({ queryKey: getGetQuoteQueryKey(quoteId) });
        toast({ title: "Product type updated", description: "This manufacturer PDF is now classified for scoped approvals." });
      },
      onError: (error: Error) => {
        toast({ title: "Could not update product type", description: error.message, variant: "destructive" });
      },
    },
  });

  const updateManufacturer = useSetManufacturerPacketManufacturer({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListManufacturerPacketsQueryKey(quoteId) });
        toast({ title: "Manufacturer updated" });
        setEditingManufacturerPacketId(null);
      },
      onError: (error: Error) => {
        toast({ title: "Could not update manufacturer", description: error.message, variant: "destructive" });
      },
    },
  });

  const hasApprovals = quote?.signed || quote?.approvalStatus === 'partial' || (quote?.approvalCoverage && quote.approvalCoverage.some((c: { status: string }) => c.status === 'signed')) || false;

  return (
    <>
      <WorkflowGuide
        quoteId={quoteId}
        hasApprovals={hasApprovals}
        hasPublishedDocument={packets.some(packet => packet.status === "approved")}
        nextStep={nextStep}
      />
      <div className="grid grid-cols-1 lg:grid-cols-[320px_1fr] xl:grid-cols-[360px_1fr] gap-6 items-start">
        <div className="space-y-4">

           <UploadCard
             quoteId={quoteId}
             productTypes={(quote?.categories ?? []) as ProductType[]}
             isQuoteLoading={isQuoteLoading}
             isQuoteFetching={isQuoteFetching}
             isQuoteError={isQuoteError}
           />

          <button
            onClick={() => setActivePacketId('manifest')}
            className={`w-full text-left p-4 rounded-xl border-2 transition-all flex flex-col items-start gap-1 ${
              activePacketId === 'manifest'
                ? "border-primary bg-primary text-primary-foreground shadow-md"
                : "border-border bg-card hover:border-border hover:bg-muted text-foreground"
            }`}
          >
            <span className="font-bold text-sm tracking-wide flex items-center gap-2">
              <LayoutList className="w-4 h-4" /> Customer Package
            </span>
            <span className={`text-xs font-medium ${activePacketId === 'manifest' ? 'text-primary-foreground/70' : 'text-muted-foreground'}`}>
              Advanced: Reorder & select individual pages
            </span>
          </button>

          <Card className="border-border shadow-sm bg-card overflow-hidden">
            <CardHeader className="py-3 bg-muted/50 border-b border-border">
              <CardTitle className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Uploaded Quotes</CardTitle>
            </CardHeader>
            <CardContent className="p-3 space-y-2">
              {isLoading && <div className="text-center p-4"><Loader2 className="w-5 h-5 animate-spin mx-auto text-muted-foreground/70" /></div>}
              {isError && (
                <div className="rounded-md border border-red-200 bg-red-50 p-3 text-xs text-red-800" role="alert">
                  <p className="font-semibold">Could not load uploaded quotes.</p>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="mt-2 h-8 border-red-200 bg-card text-red-700 hover:bg-red-100"
                    onClick={() => void refetchPackets()}
                  >
                    <RotateCcw className="mr-1.5 h-3.5 w-3.5" /> Retry
                  </Button>
                </div>
              )}
              {!isLoading && !isError && packets.length === 0 && (
                <p className="text-xs text-muted-foreground text-center py-4 bg-muted rounded border border-dashed border-border">
                  No manufacturer quotes uploaded yet.
                </p>
              )}
              {packets.map(packet => (
                <div key={packet.id} className="relative group rounded-lg border border-border bg-card">
                  <button
                    onClick={() => setActivePacketId(packet.id)}
                    data-testid={`button-uploaded-packet-${packet.id}`}
                    className={`w-full text-left p-3 pr-10 rounded-t-lg transition-all ${
                      activePacketId === packet.id
                        ? "bg-muted ring-1 ring-inset ring-slate-400/30"
                        : "hover:bg-muted/50"
                    }`}
                  >
                    <div className="flex justify-between items-start mb-1">
                      <span className="font-bold text-sm text-foreground truncate pr-2">{packet.originalName}</span>
                    </div>
                    <div className="flex flex-col gap-1.5 mt-2">
                      <StatusBadge status={packet.status} />
                    </div>
                  </button>
                  <div className="mx-3 mb-3 pt-3 border-t border-border flex flex-col gap-2">
                       {editingManufacturerPacketId === packet.id ? (
                         <div className="flex gap-1">
                           <Input
                             value={manufacturerEditValue}
                             onChange={(e) => setManufacturerEditValue(e.target.value)}
                             className="h-8 text-xs px-2"
                             placeholder="Manufacturer name"
                             autoFocus
                             onKeyDown={(e) => {
                               if (e.key === 'Enter') {
                                 if (manufacturerEditValue.trim()) {
                                   updateManufacturer.mutate({ id: quoteId, packetId: packet.id, data: { manufacturer: manufacturerEditValue.trim() }});
                                 } else {
                                   setEditingManufacturerPacketId(null);
                                 }
                               } else if (e.key === 'Escape') {
                                 setEditingManufacturerPacketId(null);
                               }
                             }}
                             onBlur={() => {
                               if (manufacturerEditValue.trim() && manufacturerEditValue.trim() !== packet.manufacturer) {
                                 updateManufacturer.mutate({ id: quoteId, packetId: packet.id, data: { manufacturer: manufacturerEditValue.trim() }});
                               } else {
                                 setEditingManufacturerPacketId(null);
                               }
                             }}
                           />
                         </div>
                       ) : (
                         <button
                           onClick={(e) => {
                             e.stopPropagation();
                             setManufacturerEditValue(packet.manufacturer || "");
                             setEditingManufacturerPacketId(packet.id);
                           }}
                           className={`h-8 w-full text-xs font-semibold rounded-md border flex items-center px-3 justify-between ${!packet.manufacturer ? "border-amber-300 bg-amber-50 text-amber-800" : "bg-card text-muted-foreground border-border hover:bg-muted"}`}
                         >
                           <span className="truncate">{packet.manufacturer || "Needs manufacturer"}</span>
                         </button>
                       )}
                       <Select
                         value={packet.productType ?? "unassigned"}
                         disabled={!quote || updateProductType.isPending}
                         onValueChange={(value) => {
                            if (value !== "unassigned") updateProductType.mutate({ id: quoteId, packetId: packet.id, data: { productType: value as ProductType } });
                         }}
                       >
                         <SelectTrigger
                           className={`h-8 w-full text-xs font-semibold ${!packet.productType ? "border-amber-300 bg-amber-50 text-amber-800" : "bg-card text-muted-foreground border-border"}`}
                         >
                           <SelectValue placeholder="Needs product type" />
                         </SelectTrigger>
                         <SelectContent>
                           {!packet.productType && <SelectItem value="unassigned">Assignment required</SelectItem>}
                           {(quote?.categories ?? []).map((type) => (
                             <SelectItem key={type} value={type}>{categoryLabel(type)}</SelectItem>
                           ))}
                         </SelectContent>
                       </Select>
                  </div>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="absolute right-2 top-2 h-7 w-7 text-muted-foreground hover:text-destructive hover:bg-destructive/10 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity"
                    onClick={(e) => {
                      e.stopPropagation();
                      if (confirm(`Delete this uploaded manufacturer quote? Any customer pages from it will be removed. ${hasApprovals ? "Affected products require new approval; original signatures remain on file." : "Only do this after a replacement is published."}`)) {
                        deletePacket.mutate({ id: quoteId, packetId: packet.id }, {
                          onSuccess: () => {
                            toast({ title: "Manufacturer quote deleted" });
                            queryClient.invalidateQueries({ queryKey: getListManufacturerPacketsQueryKey(quoteId) });
                            queryClient.invalidateQueries({ queryKey: getGetManufacturerPacketManifestQueryKey(quoteId) });
                            if (activePacketId === packet.id) setActivePacketId('manifest');
                          }
                        });
                      }
                    }}
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </Button>
                </div>
              ))}
            </CardContent>
          </Card>
        </div>

        <div className="min-w-0 h-[800px]">
          <div className={activePacketId === 'manifest' ? "h-full" : "hidden"}>
            <ManifestBuilder quoteId={quoteId} hasApprovals={hasApprovals} packets={packets} onOpenPacket={setActivePacketId} isVisible={activePacketId === 'manifest'} />
          </div>
          {packets.map((packet) => (
            <div key={packet.id} className={activePacketId === packet.id ? "h-full" : "hidden"}>
              <PacketDetails quoteId={quoteId} packet={packet} hasApprovals={hasApprovals} isVisible={activePacketId === packet.id} progressAdvancedAt={progressObservations.current.get(packet.id)?.advancedAt} />
            </div>
          ))}
          {activePacketId !== 'manifest' && !activePacket ? (
            <Card className="h-full flex items-center justify-center border-dashed bg-muted/50">
              <div className="text-center max-w-md mx-auto p-6">
                <FileText className="w-12 h-12 text-muted-foreground/70 mx-auto mb-4" />
                <h3 className="text-lg font-bold text-foreground mb-2">No Document Selected</h3>
                <p className="text-sm text-muted-foreground font-medium">Select the customer document or an uploaded quote from the sidebar to continue.</p>
              </div>
            </Card>
          ) : null}
        </div>
      </div>
    </>
  );
}


function WorkflowGuide({ quoteId, hasApprovals, hasPublishedDocument, nextStep }: { quoteId: number; hasApprovals: boolean; hasPublishedDocument: boolean; nextStep: string }) {
  const steps = [
    ["1", "Upload", "Upload the latest manufacturer quote PDF."],
    ["2", "Review and Clean", "Check for and redact any private wholesale information. Generate a clean preview."],
    ["3", "Add to Package", "Publish the cleaned pages to the customer document. (99% of the time, just add all pages)."],
    ["4", "Customer Signoff", "Share the document with the customer for final review and signature."],
  ] as const;

  return (
    <Card className="mb-6 border-border bg-card shadow-sm" data-testid="card-manufacturer-workflow">
      <details>
      <summary className="cursor-pointer px-6 py-4 text-sm font-semibold text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2">
        How to prepare or replace a customer document
      </summary>
      <CardContent className="space-y-4">
        <ol className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {steps.map(([number, title, description]) => (
            <li key={number} className="flex gap-3 rounded-md border border-border bg-muted/30 p-3">
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded bg-foreground text-xs font-bold text-background" aria-hidden="true">
                {number}
              </span>
              <div>
                <h3 className="font-bold text-sm text-foreground">{title}</h3>
                <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{description}</p>
              </div>
            </li>
          ))}
        </ol>
        <div className="rounded-md border border-border bg-muted/50 p-3 text-sm text-foreground flex justify-between items-center" data-testid="text-manufacturer-next-step">
          <div>
            <strong>Next step:</strong> {nextStep}
          </div>
          {hasPublishedDocument && (
            <Button asChild size="sm" className="font-bold h-8">
              <Link href={`/quotes/${quoteId}/signoff`} data-testid="link-open-signoff-document">
                Open Signoff Document
              </Link>
            </Button>
          )}
        </div>
        <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950" data-testid="card-manufacturer-replacement-guidance">
          <h3 className="font-bold">Replacing a changed manufacturer quote</h3>
          <p className="mt-1">
            Upload the replacement as a new quote and keep the old published pages in place while you review and clean the replacement.
            When the replacement is ready, choose its pages and publish the customer document; that single publish swaps the customer-facing pages.
            Only then delete the old uploaded quote if you no longer need it.
          </p>
          {hasApprovals && (
            <p className="mt-2 font-bold text-amber-900">
              This quote has customer approvals. Publishing a replacement means affected products require new approval; original signatures remain on file.
            </p>
          )}
        </div>
      </CardContent>
      </details>
    </Card>
  );
}

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, { label: string, className: string }> = {
    awaiting_upload: { label: "Uploading", className: "bg-muted text-muted-foreground border-border" },
    queued: { label: "Queued", className: "bg-muted text-muted-foreground border-border" },
    processing: { label: "Processing", className: "bg-muted text-muted-foreground border-border" },
    needs_review: { label: "Needs Review", className: "bg-amber-100 text-amber-800 border-amber-200" },
    ready_for_approval: { label: "Preview Ready", className: "bg-primary/10 text-primary border-primary/20" },
    approved: { label: "In Package", className: "bg-green-100 text-green-800 border-green-200" },
    failed: { label: "Failed", className: "bg-red-50 text-red-700 border-red-200" },
  };
  const m = map[status] || { label: status, className: "bg-muted text-muted-foreground border-border" };
  return <span className={`inline-block text-[10px] font-bold px-2 py-0.5 rounded border uppercase tracking-wider ${m.className}`}>{m.label}</span>;
}

function UploadCard({
  quoteId,
  productTypes,
  isQuoteLoading,
  isQuoteFetching,
  isQuoteError,
}: {
  quoteId: number;
  productTypes: ProductType[];
  isQuoteLoading: boolean;
  isQuoteFetching: boolean;
  isQuoteError: boolean;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [productType, setProductType] = useState<ProductType | "">("");
  const [manufacturer, setManufacturer] = useState("");
  const [customManufacturer, setCustomManufacturer] = useState(false);
  const {
    data: templateOptions = [],
    isLoading: isLoadingTemplates,
    isFetching: isFetchingTemplates,
    isError: isTemplateOptionsError,
    refetch: refetchTemplateOptions,
  } = useListManufacturerRedactionTemplateOptions({
    query: {
      queryKey: getListManufacturerRedactionTemplateOptionsQueryKey(),
      refetchOnMount: "always",
      refetchOnWindowFocus: true,
    },
  });
  const requestUpload = useRequestManufacturerPacketUpload();
  const completeUpload = useCompleteManufacturerPacketUpload();

  const eligibleProductTypes = useMemo(
    () => Array.from(new Set(productTypes)),
    [productTypes],
  );
  const manufacturers = useMemo(
    () => deduplicateManufacturerOptions(
      templateOptions.filter((option) => option.productType === productType),
    ),
    [productType, templateOptions],
  );

  // A refetch can remove or rename an active option while this form is open.
  // Never discard a value the salesperson typed: turn a stale saved choice
  // into the manual "Other" path instead.
  useEffect(() => {
    if (!productType || !eligibleProductTypes.includes(productType)) {
      if (productType && !eligibleProductTypes.includes(productType)) {
        setProductType("");
      }
      return;
    }
    if (
      customManufacturer ||
      !manufacturer.trim() ||
      isLoadingTemplates ||
      isFetchingTemplates ||
      isTemplateOptionsError
    ) {
      return;
    }
    const selected = manufacturers.find(
      (option) => canonicalManufacturer(option.manufacturer) === canonicalManufacturer(manufacturer),
    );
    if (selected) {
      if (selected.manufacturer !== manufacturer) {
        setManufacturer(selected.manufacturer);
      }
    } else {
      setCustomManufacturer(true);
    }
  }, [
    customManufacturer,
    eligibleProductTypes,
    isLoadingTemplates,
    isFetchingTemplates,
    isTemplateOptionsError,
    manufacturer,
    manufacturers,
    productType,
  ]);

  const uploadFile = async (file: File) => {
    if (!file) return;
    if (!productType) {
      toast({ title: "Product type required", description: "Choose the quote product type this manufacturer PDF belongs to before uploading.", variant: "destructive" });
      return;
    }
    if (!manufacturer.trim()) {
      toast({ title: "Manufacturer required", description: "Please enter the manufacturer name before uploading.", variant: "destructive" });
      return;
    }
    if (!file.name.toLowerCase().endsWith(".pdf") || (file.type && file.type !== "application/pdf")) {
      toast({ title: "PDF required", description: "Choose a manufacturer quote saved as a PDF.", variant: "destructive" });
      return;
    }
    if (file.size < 1 || file.size > 40 * 1024 * 1024) {
      toast({ title: "File too large", description: "Manufacturer quote PDFs must be no larger than 40 MiB.", variant: "destructive" });
      return;
    }

    setIsUploading(true);
    try {
      const req = await requestUpload.mutateAsync({
        id: quoteId,
        data: { name: file.name, size: file.size, contentType: "application/pdf" as const, manufacturer: manufacturer.trim(), productType },
      });
      const res = await fetch(req.uploadURL, { method: "PUT", headers: { "Content-Type": file.type || "application/pdf" }, body: file });
      if (!res.ok) throw new Error("Upload failed");
      await completeUpload.mutateAsync({ id: quoteId, packetId: req.packet.id });

      toast({ title: "Manufacturer quote uploaded", description: `${categoryLabel(productType)} selected. Processing started.` });
      queryClient.invalidateQueries({ queryKey: getListManufacturerPacketsQueryKey(quoteId) });
      setManufacturer("");
      setCustomManufacturer(false);
    } catch (error) {
      queryClient.invalidateQueries({ queryKey: getListManufacturerPacketsQueryKey(quoteId) });
      toast({ title: "Upload error", description: error instanceof Error ? error.message : "Failed to upload the manufacturer quote.", variant: "destructive" });
    } finally {
      setIsUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) void uploadFile(file);
  };

  return (
    <Card className="border-border shadow-sm overflow-hidden bg-card">
      <CardHeader className="pb-3 border-b bg-muted/50">
        <CardTitle className="text-sm font-bold text-foreground">New Upload</CardTitle>
        <CardDescription className="text-xs text-muted-foreground">Select details before uploading.</CardDescription>
      </CardHeader>
      <CardContent className="pt-4 p-4">
         <div className="mb-4 space-y-3">
           <div className="space-y-1.5">
             <label className="text-xs font-bold text-muted-foreground uppercase tracking-wider">Product Type</label>
              <Select value={productType} onValueChange={(value) => {
               setProductType(value as ProductType);
               setManufacturer("");
               setCustomManufacturer(false);
              }} disabled={isUploading || isQuoteLoading || isQuoteFetching || eligibleProductTypes.length === 0}>
               <SelectTrigger className="bg-card font-medium text-sm h-10 border-border">
                  <SelectValue placeholder={
                    isQuoteLoading
                      ? "Loading quote categories..."
                      : isQuoteError
                        ? "Quote categories unavailable"
                        : eligibleProductTypes.length
                          ? "Select product type..."
                          : "No quote product types"
                  } />
               </SelectTrigger>
               <SelectContent>
                  {eligibleProductTypes.map((type) => <SelectItem key={type} value={type}>{categoryLabel(type)}</SelectItem>)}
               </SelectContent>
             </Select>
              {isQuoteError && (
                <p className="text-xs text-red-700" role="alert">Could not load this quote's eligible product categories. Refresh and try again.</p>
              )}
           </div>
           <div className="space-y-1.5">
             <label className="text-xs font-bold text-muted-foreground uppercase tracking-wider">Manufacturer</label>
             <Select
               value={customManufacturer ? "__other" : manufacturer}
               onValueChange={(value) => {
                 const isOther = value === "__other";
                 setCustomManufacturer(isOther);
                 setManufacturer(isOther ? "" : value);
               }}
                disabled={isUploading || !productType}
             >
               <SelectTrigger className="bg-card font-medium text-sm h-10 border-border">
                 <SelectValue placeholder={
                   !productType
                     ? "Select product type first..."
                     : isLoadingTemplates
                       ? "Loading manufacturers..."
                       : "Select manufacturer..."
                 } />
               </SelectTrigger>
               <SelectContent>
                 {manufacturers.map((option) => (
                   <SelectItem key={`${option.productType}:${canonicalManufacturer(option.manufacturer)}`} value={option.manufacturer}>
                     {option.manufacturer}
                   </SelectItem>
                 ))}
                 <SelectItem value="__other">Other manufacturer...</SelectItem>
               </SelectContent>
             </Select>
             {isTemplateOptionsError ? (
               <div className="flex items-center justify-between gap-2 text-xs text-red-700" role="alert">
                 <span>Saved manufacturers could not be loaded.</span>
                 <Button
                   type="button"
                   variant="ghost"
                   size="sm"
                   className="h-7 px-2 text-red-700 hover:bg-red-50 hover:text-red-800"
                   onClick={() => void refetchTemplateOptions()}
                 >
                   <RotateCcw className="mr-1 h-3 w-3" /> Retry
                 </Button>
               </div>
             ) : !isLoadingTemplates && manufacturers.length === 0 && productType ? (
               <p className="text-xs text-muted-foreground">No saved manufacturer matches this quote category. Choose Other to enter one manually.</p>
             ) : null}
             {customManufacturer && (
               <Input
                 aria-label="Other manufacturer name"
                 placeholder="e.g. Andersen, Reeb"
                 value={manufacturer}
                 onChange={(e) => setManufacturer(e.target.value)}
                 disabled={isUploading}
                 className="h-10 text-sm font-medium"
                 autoFocus
               />
             )}
           </div>
         </div>
        <input ref={fileInputRef} type="file" accept="application/pdf" className="hidden" onChange={handleFileChange} disabled={isUploading || !productType || !manufacturer.trim()} />
        <Button
          className="w-full font-bold h-10 text-sm shadow-sm"
          disabled={isUploading || !productType || !manufacturer.trim()}
          onClick={() => fileInputRef.current?.click()}
        >
          {isUploading ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Upload className="w-4 h-4 mr-2" />}
          {isUploading ? "Uploading quote..." : "Upload Quote PDF"}
        </Button>
      </CardContent>
    </Card>
  );
}

function PacketDetails({ quoteId, packet, hasApprovals, isVisible, progressAdvancedAt }: { quoteId: number, packet: ManufacturerPacket, hasApprovals: boolean, isVisible: boolean, progressAdvancedAt?: number }) {
  const retry = useRetryManufacturerPacket();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  if (packet.status === "awaiting_upload") {
    return (
      <Card className="h-full flex flex-col items-center justify-center p-12 text-center border-dashed bg-muted/50">
        <Upload className="w-10 h-10 text-muted-foreground/70 mb-4" />
        <h3 className="text-lg font-bold text-foreground mb-2">Upload is not complete</h3>
        <p className="text-sm text-muted-foreground max-w-sm">
          The secure PDF upload has not finished yet. Return to the upload form and try the quote again.
        </p>
      </Card>
    );
  }

  if (packet.status === "queued" || packet.status === "processing") {
    const processingAge = Math.min(packetProcessingAgeMs(packet), progressAdvancedAt === undefined ? Infinity : Math.max(0, Date.now() - progressAdvancedAt));
    const delayed = processingAge >= PROCESSING_SLOW_AFTER_MS;
    const pollingStopped = processingAge >= PROCESSING_POLL_STOP_AFTER_MS;
    return (
      <Card className={`h-full flex flex-col items-center justify-center p-12 text-center border-dashed ${delayed ? "border-amber-300 bg-amber-50/60" : "bg-muted/50"}`}>
        {delayed ? (
          <AlertTriangle className="w-10 h-10 text-amber-600 mb-4" />
        ) : (
          <Loader2 className="w-10 h-10 animate-spin text-muted-foreground mb-4" />
        )}
        <h3 className="text-lg font-bold text-foreground mb-2">
          {delayed ? "Processing is taking longer than expected" : ({
            queued: "Queued for processing",
            analyzing: "Analyzing document",
            rendering: "Rendering cleaned pages",
            finalizing: "Finalizing document",
          }[packet.processingProgress?.stage ?? packet.status] ?? "Processing document")}
        </h3>
        {packet.processingProgress && (
          <p className="text-sm text-muted-foreground mb-2" data-testid={`status-processing-progress-${packet.id}`} role="status">
            {packet.processingProgress.stage} — {packet.processingProgress.completedPages} of {packet.processingProgress.totalPages} pages completed
          </p>
        )}
        <p className="text-sm text-muted-foreground max-w-sm">
          {pollingStopped
            ? "Automatic status checks have stopped. Check again now; if processing failed, retry once or split this manufacturer quote into smaller PDFs."
            : delayed
              ? "The quote is still queued or processing. Status checks will continue at a reduced rate."
              : "Pages will be available for review and approval only when processing finishes."}
        </p>
        {delayed && (
          <Button
            variant="outline"
            className="mt-5 bg-card"
            onClick={() =>
              queryClient.invalidateQueries({
                queryKey: getListManufacturerPacketsQueryKey(quoteId),
              })
            }
          >
            <RotateCcw className="w-4 h-4 mr-2" />
            Check status
          </Button>
        )}
      </Card>
    );
  }

  if (packet.status === "failed") {
    return (
      <Card className="border-red-200 bg-red-50/50">
        <CardHeader>
          <CardTitle className="text-red-800 flex items-center text-lg">
            <AlertTriangle className="w-5 h-5 mr-2" /> Processing Failed
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-red-700 text-sm font-medium mb-6">
            {packet.failureMessage || "An unknown error occurred while analyzing the document."}
          </p>
          {packet.processingProgress && (
            <p className="text-red-700 text-sm mb-6" data-testid={`status-processing-error-${packet.id}`}>
              Stopped during {packet.processingProgress.errorStage ?? packet.processingProgress.stage} — {packet.processingProgress.completedPages} of {packet.processingProgress.totalPages} pages completed. No partial document is available for approval.
            </p>
          )}
          <Button
            variant="outline"
            className="bg-card border-red-200 text-red-700 hover:bg-red-50 hover:text-red-800"
            disabled={retry.isPending}
            onClick={() => {
              retry.mutate({ id: quoteId, packetId: packet.id }, {
                  onSuccess: () => queryClient.invalidateQueries({ queryKey: getListManufacturerPacketsQueryKey(quoteId) }),
                  onError: (error: Error) => toast({
                    title: "Retry failed",
                    description: error.message || "The packet could not be queued again.",
                    variant: "destructive",
                  }),
              });
            }}
          >
            {retry.isPending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <RotateCcw className="w-4 h-4 mr-2" />}
            Retry Processing
          </Button>
        </CardContent>
      </Card>
    );
  }

  // needs_review, ready_for_approval, approved
  return <PacketReview quoteId={quoteId} packet={packet} hasApprovals={hasApprovals} isVisible={isVisible} />;
}

function PageThumbnail({ quoteId, packetId, pageNumber, type, enabled = true, revision }: { quoteId: number, packetId: number, pageNumber: number, type: 'source'|'cleaned', enabled?: boolean, revision?: string }) {
  const { ref, visible } = usePreviewVisibility<HTMLDivElement>(enabled);
  return (
    <div ref={ref} className="w-full h-full">
      {visible ? (
        <PageThumbnailRequest key={`${type}:${revision ?? "source"}`} quoteId={quoteId} packetId={packetId} pageNumber={pageNumber} type={type} revision={revision} />
      ) : (
        <div className="w-full h-full flex items-center justify-center bg-muted/50" aria-label={`Preview placeholder for page ${pageNumber}`}>
          <FileImage className="w-4 h-4 text-muted-foreground/30" />
        </div>
      )}
    </div>
  );
}

function PageThumbnailRequest({ quoteId, packetId, pageNumber, type, revision }: { quoteId: number, packetId: number, pageNumber: number, type: 'source'|'cleaned', revision?: string }) {
  const [attempt, setAttempt] = useState(0);
  const cleanedQueryKey = useMemo(
    () => cleanedManufacturerPacketPreviewQueryKey(quoteId, packetId, pageNumber, revision ?? "unknown"),
    [packetId, pageNumber, quoteId, revision],
  );
  const sourceQuery = useGetManufacturerPacketSourcePage(quoteId, packetId, pageNumber, {
    query: {
      enabled: type === 'source', retry: false, staleTime: Infinity,
      queryKey: [...getGetManufacturerPacketSourcePageQueryKey(quoteId, packetId, pageNumber), attempt],
      queryFn: ({ signal }) => previewFetchScheduler.run(
        () => getManufacturerPacketSourcePage(quoteId, packetId, pageNumber, { signal }), signal,
      ),
    }
  });
  const cleanedQuery = useGetManufacturerPacketPage(quoteId, packetId, pageNumber, undefined, {
    query: {
      enabled: type === 'cleaned', retry: false, staleTime: Infinity,
      queryKey: [...cleanedQueryKey, attempt],
      queryFn: ({ signal }) => previewFetchScheduler.run(
        () => getManufacturerPacketPage(quoteId, packetId, pageNumber, undefined, { signal }), signal,
      ),
    }
  });

  const blob = type === 'source' ? sourceQuery.data : cleanedQuery.data;
  const isLoading = type === 'source' ? sourceQuery.isLoading : cleanedQuery.isLoading;
  const isError = type === 'source' ? sourceQuery.isError : cleanedQuery.isError;

  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    if (blob) {
      const u = URL.createObjectURL(blob);
      setUrl(u);
      return () => URL.revokeObjectURL(u);
    }
    return undefined;
  }, [blob]);

  if (isLoading) return <div className="w-full h-full flex items-center justify-center bg-muted/50"><Loader2 className="w-4 h-4 animate-spin text-muted-foreground/50" /></div>;
  if (isError) return (
    <div className="w-full h-full flex flex-col gap-1 items-center justify-center bg-muted/50">
      <FileImage className="w-4 h-4 text-muted-foreground/40" />
      <button type="button" className="text-[9px] font-bold text-primary hover:underline" onClick={() => setAttempt(value => value + 1)} data-testid={`button-retry-thumbnail-${packetId}-${pageNumber}`}>
        Retry
      </button>
    </div>
  );
  if (!url) return <div className="w-full h-full flex items-center justify-center bg-muted/50"><FileImage className="w-4 h-4 text-muted-foreground/30" /></div>;

  return <img src={url} className="w-full h-full object-cover" alt={`Pg ${pageNumber}`} />;
}

function TemplateFeedbackNotice({
  feedback,
}: {
  feedback: { code: TemplateFeedbackCode; message: string };
}) {
  const title = feedback.code === "no_active_match"
    ? "No active template matched"
    : "Template layout was incompatible";
  return (
    <div
      className="mt-2 flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 p-2 text-xs text-amber-950"
      data-testid={`packet-template-feedback-${feedback.code}`}
      role="status"
    >
      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600" />
      <span><strong>{title}:</strong> {feedback.message}</span>
    </div>
  );
}

function PacketReview({ quoteId, packet, hasApprovals, isVisible }: { quoteId: number, packet: ManufacturerPacket, hasApprovals: boolean, isVisible: boolean }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const submitRedactions = useSetManufacturerPacketRedactions();

  const { data: dbUser } = useGetCurrentUser();
  const isAdmin = dbUser?.role === 'admin';

  const analysis = packet.analysis || [];
  const { data: manifest, isLoading: isManifestLoading } = useGetManufacturerPacketManifest(quoteId);
  const setManifest = useSetManufacturerPacketManifest();

  const [redactions, setRedactions] = useState<Record<string, PacketRect[]>>(() => {
    const init: Record<string, PacketRect[]> = {};
    if (packet.manualRedactions) Object.assign(init, packet.manualRedactions);
    else analysis.forEach(a => { init[a.pageNumber.toString()] = [...a.suggestedRects]; });
    return init;
  });
  const redactionsRef = useRef(redactions);
  const updateRedactions = useCallback((
    next: Record<string, PacketRect[]> | ((current: Record<string, PacketRect[]>) => Record<string, PacketRect[]>),
  ) => {
    const resolved = typeof next === "function" ? next(redactionsRef.current) : next;
    redactionsRef.current = resolved;
    setRedactions(resolved);
  }, []);

  const [currentPageNum, setCurrentPageNum] = useState<number>(analysis[0]?.pageNumber || 1);
  const [viewMode, setViewMode] = useState<'source' | 'cleaned'>(
    packet.status === 'ready_for_approval' || packet.status === 'approved' ? 'cleaned' : 'source'
  );
  const isApproved = packet.status === 'approved';

  useEffect(() => {
    if (isApproved) setViewMode('cleaned');
  }, [isApproved]);

  const currentPage = analysis.find(a => a.pageNumber === currentPageNum);
  const pageRedactions = redactions[currentPageNum.toString()] || [];

  const isIncluded = manifest?.entries.some(e => e.packetId === packet.id);
  const templateFeedback = parseTemplateFeedback(packet.failureMessage);

  const handleSaveRedactions = async (): Promise<boolean> => {
    const submittedRedactions = Object.fromEntries(
      Object.entries(redactionsRef.current).map(([page, rectangles]) => [
        page,
        rectangles.map((rectangle) => ({ ...rectangle })),
      ]),
    );
    return new Promise((resolve) => {
      submitRedactions.mutate({
        id: quoteId,
        packetId: packet.id,
        data: { redactionsByPage: submittedRedactions }
      }, {
        onSuccess: () => {
          analysis.forEach((page) => {
            queryClient.removeQueries({
              queryKey: getGetManufacturerPacketPageQueryKey(
                quoteId,
                packet.id,
                page.pageNumber,
                undefined,
              ),
            });
          });
          toast({ title: "Redactions submitted", description: "The clean preview is being generated." });
          queryClient.invalidateQueries({ queryKey: getListManufacturerPacketsQueryKey(quoteId) });
          setViewMode('cleaned');
          resolve(true);
        },
        onError: (err: Error) => {
          toast({ title: "Submission failed", description: err.message || "Failed to submit redactions.", variant: "destructive" });
          resolve(false);
        }
      });
    });
  };

  const handleAddAllToPackage = () => {
    if (isManifestLoading) {
      toast({ title: "Please wait", description: "Loading package contents...", variant: "destructive" });
      return;
    }
    if (!manifest) return;

    if (hasApprovals) {
      if (!window.confirm("Warning: This quote has customer approvals. Updating the document means affected products require new approval; original signatures remain on file. Continue?")) {
        return;
      }
    }

    const existing = manifest.entries || [];
    const firstIndex = existing.findIndex(e => e.packetId === packet.id);
    const otherEntries = existing.filter(e => e.packetId !== packet.id);

    const newEntries = analysis.map((a) => ({
      packetId: packet.id,
      pageNumber: a.pageNumber,
      pageOrder: 0
    }));

    const combined = [...otherEntries];
    if (firstIndex !== -1) {
      combined.splice(firstIndex, 0, ...newEntries);
    } else {
      combined.push(...newEntries);
    }

    const orderedCombined = combined.map((e, i) => ({
      ...e,
      pageOrder: i + 1
    }));

    setManifest.mutate({
      id: quoteId,
      data: { entries: orderedCombined }
    }, {
      onSuccess: () => {
        toast({ title: "Pages added to customer package.", description: "The entire cleaned upload is now included." });
        queryClient.invalidateQueries({ queryKey: getListManufacturerPacketsQueryKey(quoteId) });
        queryClient.invalidateQueries({ queryKey: getGetManufacturerPacketManifestQueryKey(quoteId) });
      }
    });
  };

  if (analysis.length === 0) {
    return (
      <Card>
        <CardContent className="space-y-3 p-8 text-center text-muted-foreground">
          {templateFeedback && <TemplateFeedbackNotice feedback={templateFeedback} />}
          <p>No page analysis data.</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="h-full flex flex-col overflow-hidden border-border shadow-md bg-card">
      <div className="flex flex-col md:flex-row items-start md:items-center justify-between p-4 border-b border-border bg-muted/30 z-10 relative gap-4">
        <div className="flex-1 min-w-0 pr-4">
          <div className="flex items-center gap-2">
            <h2 className="text-lg font-bold text-foreground truncate">{packet.originalName}</h2>
            {packet.appliedTemplate?.name && (
              <span className="text-[10px] uppercase tracking-wider font-bold bg-green-100 text-green-800 px-2 py-0.5 rounded border border-green-200">
                Template Applied
              </span>
            )}
          </div>
          <p className="text-muted-foreground text-xs mt-0.5">
            {isApproved
              ? "This packet is in the customer package, so its redactions are read-only. Remove the packet from the customer package before editing redactions."
              : viewMode === 'source'
                ? "Draw boxes over private details, then generate a clean preview."
                : "Review the cleaned preview before adding to the package."}
            {packet.appliedTemplate?.name && (
              <span className="text-green-700 ml-2 font-medium">
                {viewMode === 'source' ? "Auto-prepopulated" : "Applied"} from “{packet.appliedTemplate.name}” ({packet.appliedTemplate.manufacturer} · {categoryLabel(packet.appliedTemplate.productType as QuoteCategoriesItem)}).
              </span>
            )}
          </p>
          {isAdmin && (
            <Link
              href="/admin/templates"
              className="mt-1 inline-block text-xs font-semibold text-primary hover:underline"
            >
              Templates
            </Link>
          )}
          {templateFeedback && <TemplateFeedbackNotice feedback={templateFeedback} />}
        </div>
        <div className="flex gap-3 items-center shrink-0 w-full md:w-auto justify-between md:justify-end">
          <div className="flex bg-muted p-1 rounded-md border border-border">
            <button
              className={`px-3 py-1.5 text-xs font-bold rounded transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${viewMode === 'source' ? 'bg-card shadow-sm text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
              disabled={isApproved}
              onClick={() => setViewMode('source')}
              title={isApproved ? "Remove this packet from the customer package before editing redactions." : undefined}
            >
              Source Editor
            </button>
            <button
              className={`px-3 py-1.5 text-xs font-bold rounded transition-colors ${viewMode === 'cleaned' ? 'bg-card shadow-sm text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
              disabled={packet.status !== "ready_for_approval" && packet.status !== "approved"}
              onClick={() => setViewMode('cleaned')}
            >
              Cleaned Preview
            </button>
          </div>

          {viewMode === 'source' && !isApproved ? (
            <div className="flex gap-2">
              <Button onClick={() => handleSaveRedactions()} disabled={submitRedactions.isPending} className="bg-foreground text-background hover:bg-foreground/90 h-9 font-bold">
                {submitRedactions.isPending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}
                Approve
              </Button>
            </div>
          ) : (
            <Button
              onClick={handleAddAllToPackage}
              disabled={setManifest.isPending}
              className="bg-primary text-primary-foreground hover:bg-primary/90 h-9 font-bold shadow-sm"
            >
              {setManifest.isPending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Save className="w-4 h-4 mr-2" />}
              {isIncluded ? "Update Customer Package" : "Add All Pages to Package"}
            </Button>
          )}
        </div>
      </div>

      <div className="flex flex-1 min-h-0 overflow-hidden">
        {/* Thumbnail Sidebar */}
        <div className="w-24 md:w-32 border-r border-border bg-muted/20 overflow-y-auto p-2 flex flex-col gap-2">
          {analysis.map(a => (
            <button
              key={a.pageNumber}
              aria-label={`Pg ${a.pageNumber}`}
              onClick={() => setCurrentPageNum(a.pageNumber)}
              className={`w-full text-center flex flex-col gap-1 p-1.5 rounded-lg border-2 transition-colors ${
                currentPageNum === a.pageNumber
                  ? "border-foreground bg-muted/50"
                  : "border-transparent hover:bg-muted"
              }`}
            >
              <div className="w-full aspect-[3/4] bg-card border border-border shadow-sm overflow-hidden flex items-center justify-center relative">
                <PageThumbnail quoteId={quoteId} packetId={packet.id} pageNumber={a.pageNumber} type={viewMode} enabled={isVisible} revision={String(packet.updatedAt)} />
                {viewMode === 'source' && redactions[a.pageNumber.toString()]?.length > 0 && (
                  <div className="absolute top-0 right-0 bg-destructive text-destructive-foreground text-[8px] font-bold px-1 py-0.5 rounded-bl shadow-sm">
                    Redacted
                  </div>
                )}
              </div>
              <span className={`text-[10px] font-bold ${currentPageNum === a.pageNumber ? 'text-foreground' : 'text-muted-foreground'}`}>
                Pg {a.pageNumber}
                {a.pageType === "unknown" && <AlertTriangle className="w-3 h-3 inline-block ml-1 opacity-70 text-amber-500" />}
              </span>
            </button>
          ))}
        </div>

        {/* Main Editor / Preview Area */}
        <div className="flex-1 flex flex-col bg-muted/10 relative overflow-hidden">
          <div className="flex-1 overflow-auto p-4 flex items-start justify-center">
            {currentPage && viewMode === 'source' && !isApproved && (
              <PageRedactionEditor
                key={`${packet.id}:${currentPage.pageNumber}`}
                quoteId={quoteId}
                packetId={packet.id}
                pageAnalyses={analysis}
                pageAnalysis={currentPage}
                redactions={pageRedactions}
                 previewEnabled={isVisible}
                onChange={(newRedactions) => {
                   updateRedactions(prev => ({ ...prev, [currentPage.pageNumber.toString()]: newRedactions }));
                }}
                onApplyToPages={(rect, targetPageNumbers) => {
                  const newMap = { ...redactions };
                  const targetPages = new Set(targetPageNumbers);
                  let appliedCount = 0;
                  analysis.forEach(a => {
                    if (targetPages.has(a.pageNumber)) {
                      const key = a.pageNumber.toString();
                      const existing = newMap[key] || [];
                      const alreadyApplied = existing.some(existingRect =>
                        Math.abs(existingRect.x - rect.x) < 0.5 &&
                        Math.abs(existingRect.y - rect.y) < 0.5 &&
                        Math.abs(existingRect.width - rect.width) < 0.5 &&
                        Math.abs(existingRect.height - rect.height) < 0.5,
                      );
                      if (!alreadyApplied) {
                        newMap[key] = [...existing, { ...rect }];
                        appliedCount++;
                      }
                    }
                  });
                  updateRedactions(newMap);
                  toast({
                    title: "Redaction applied",
                    description: appliedCount === 1
                      ? "Redaction added to 1 selected page."
                      : `Redaction added to ${appliedCount} selected pages. Existing boxes were left unchanged.`,
                  });
                }}
              />
            )}
            {currentPage && viewMode === 'cleaned' && (
               <SanitizedPagePreview quoteId={quoteId} packetId={packet.id} pageNumber={currentPage.pageNumber} enabled={isVisible} revision={String(packet.updatedAt)} />
            )}
          </div>
        </div>
      </div>
    </Card>
  );
}

function ManifestBuilder({ quoteId, hasApprovals, packets, onOpenPacket, isVisible }: { quoteId: number, hasApprovals: boolean, packets: ManufacturerPacket[], onOpenPacket: (packetId: number) => void, isVisible: boolean }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data: manifest, isLoading } = useGetManufacturerPacketManifest(quoteId);
  const setManifest = useSetManufacturerPacketManifest();

  const [entries, setEntries] = useState<{packetId: number, pageNumber: number, id: string}[]>([]);

  useEffect(() => {
    if (manifest) {
      setEntries(manifest.entries.sort((a, b) => a.pageOrder - b.pageOrder).map(e => ({
        packetId: e.packetId,
        pageNumber: e.pageNumber,
        id: `${e.packetId}-${e.pageNumber}-${Math.random()}`
      })));
    } else {
      setEntries([]);
    }
  }, [manifest]);

  const handleSave = () => {
    if (hasApprovals) {
      if (!window.confirm("Warning: This quote has customer approvals. Publishing these pages means affected products require new approval; original signatures remain on file. Continue?")) return;
    }
    setManifest.mutate({
      id: quoteId,
      data: { entries: entries.map((e, idx) => ({ packetId: e.packetId, pageNumber: e.pageNumber, pageOrder: idx + 1 })) }
    }, {
      onSuccess: () => {
        toast({ title: "Customer package updated", description: "Selected pages are ready for signoff." });
        queryClient.invalidateQueries({ queryKey: getListManufacturerPacketsQueryKey(quoteId) });
        queryClient.invalidateQueries({ queryKey: getGetManufacturerPacketManifestQueryKey(quoteId) });
      }
    });
  };

  const moveUp = (idx: number) => {
    if (idx === 0) return;
    const newEntries = [...entries];
    [newEntries[idx - 1], newEntries[idx]] = [newEntries[idx], newEntries[idx - 1]];
    setEntries(newEntries);
  };

  const moveDown = (idx: number) => {
    if (idx === entries.length - 1) return;
    const newEntries = [...entries];
    [newEntries[idx + 1], newEntries[idx]] = [newEntries[idx], newEntries[idx + 1]];
    setEntries(newEntries);
  };

  if (isLoading) return <Card><CardContent className="p-12 flex justify-center"><Loader2 className="w-8 h-8 animate-spin text-muted-foreground/70" /></CardContent></Card>;

  return (
    <Card className="h-full flex flex-col border-border shadow-md bg-card">
      <CardHeader className="bg-muted/30 border-b border-border pb-4">
        <div className="flex justify-between items-start gap-4">
          <div>
            <CardTitle className="text-lg">Customer Package</CardTitle>
            <CardDescription className="text-muted-foreground mt-1">
              Advanced: Select and reorder specific pages from cleaned manufacturer quotes.
            </CardDescription>
          </div>
          <Button onClick={handleSave} disabled={setManifest.isPending} className="bg-foreground text-background font-bold shadow-sm">
            {setManifest.isPending ? "Saving..." : "Save Quote Package"}
          </Button>
        </div>
      </CardHeader>

      <div className="flex flex-1 min-h-0 overflow-hidden">
        <div className="w-64 border-r border-border bg-muted/20 overflow-y-auto p-4 space-y-4">
          <h3 className="font-bold text-xs uppercase tracking-wider text-muted-foreground mb-2">Available Packets</h3>
          {packets.length === 0 && (
            <p className="text-xs text-muted-foreground italic">No cleaned packets available.</p>
          )}
          {packets.map(p => {
            const isReady = p.status === 'ready_for_approval' || p.status === 'approved';
            return (
            <div key={p.id} className="bg-card p-3 rounded-lg border border-border shadow-sm space-y-2">
              <button
                type="button"
                className="w-full rounded text-left hover:text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary"
                onClick={() => onOpenPacket(p.id)}
                aria-label={`Open ${p.originalName} for review`}
                data-testid={`button-open-available-packet-${p.id}`}
              >
              <span className="block font-bold text-sm truncate" title={p.originalName}>{p.originalName}</span>
              <span className="flex justify-between items-center text-xs text-muted-foreground mt-2">
                <span>{p.analysis?.length || 0} pages</span>
                {!isReady && <span className="text-[10px] uppercase font-bold text-amber-600 bg-amber-50 px-1.5 py-0.5 rounded border border-amber-200">{p.status.replace(/_/g, ' ')}</span>}
              </span>
              <span className="block mt-2 text-xs font-semibold text-primary">Open for review</span>
              </button>
              <Button
                size="sm"
                variant="secondary"
                disabled={!isReady || !p.analysis || p.analysis.length === 0}
                className="w-full text-xs font-bold"
                onClick={() => {
                  const newEntries = p.analysis?.map(a => ({ packetId: p.id, pageNumber: a.pageNumber, id: Math.random().toString() })) || [];
                  setEntries([...entries, ...newEntries]);
                }}
              >
                Add All Pages
              </Button>
            </div>
          )})}
        </div>

        <CardContent className="flex-1 p-6 flex flex-col overflow-y-auto bg-muted/5">
          <div className="flex justify-between items-center mb-4">
             <h4 className="text-sm font-bold text-foreground">Document Sequence ({entries.length})</h4>
             {entries.length > 0 && (
               <Button variant="ghost" size="sm" className="h-8 text-destructive hover:bg-destructive/10 text-xs font-bold" onClick={() => setEntries([])}>
                 Clear All
               </Button>
             )}
          </div>

          {entries.length === 0 ? (
            <div className="flex-1 border-2 border-dashed border-border rounded-xl flex flex-col items-center justify-center p-8 bg-card text-center min-h-[300px]">
              <FileImage className="w-12 h-12 text-muted-foreground/30 mb-4" />
              <h3 className="text-lg font-bold text-foreground">No pages in sequence</h3>
              <p className="text-sm text-muted-foreground max-w-sm mt-2">
                Add pages from the available packets on the left to build the customer-facing document.
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              {entries.map((entry, idx) => {
                const p = packets.find(x => x.id === entry.packetId);
                return (
                  <div key={entry.id} className="flex items-center gap-3 bg-card p-2 rounded-lg border border-border shadow-sm">
                    <div className="flex flex-col gap-1 border-r border-border pr-2">
                      <Button size="icon" variant="ghost" className="h-6 w-6" onClick={() => moveUp(idx)} disabled={idx === 0}>▲</Button>
                      <Button size="icon" variant="ghost" className="h-6 w-6" onClick={() => moveDown(idx)} disabled={idx === entries.length - 1}>▼</Button>
                    </div>

                    <div className="w-12 h-16 shrink-0 border border-border bg-muted flex items-center justify-center overflow-hidden rounded relative">
                       {p && (p.status === 'ready_for_approval' || p.status === 'approved') ? (
                          <PageThumbnail quoteId={quoteId} packetId={entry.packetId} pageNumber={entry.pageNumber} type="cleaned" enabled={isVisible} revision={String(p.updatedAt)} />
                       ) : (
                         <div className="flex flex-col items-center justify-center w-full h-full bg-amber-50">
                           <AlertTriangle className="w-4 h-4 text-amber-500 mb-1" />
                           <span className="text-[8px] font-bold text-amber-700 leading-tight text-center px-1">Not Ready</span>
                         </div>
                       )}
                    </div>

                    <div className="flex-1 min-w-0 pl-2">
                      <div className="font-bold text-sm truncate text-foreground">{p?.originalName || "Unknown packet"}</div>
                      <div className="text-xs text-muted-foreground font-medium">Page {entry.pageNumber}</div>
                      {p?.productType && (
                        <div className="text-[10px] text-muted-foreground uppercase font-bold mt-1">
                          {categoryLabel(p.productType as QuoteCategoriesItem)}
                        </div>
                      )}
                    </div>

                    <Button size="icon" variant="ghost" className="text-muted-foreground hover:text-destructive hover:bg-destructive/10 h-8 w-8" onClick={() => setEntries(entries.filter((_, i) => i !== idx))}>
                      <X className="w-4 h-4" />
                    </Button>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </div>
    </Card>
  );
}

function PageRedactionEditor({
  quoteId,
  packetId,
  pageAnalyses,
  pageAnalysis,
  redactions,
  previewEnabled,
  onChange,
  onApplyToPages
}: {
  quoteId: number,
  packetId: number,
  pageAnalyses: PacketPageAnalysis[],
  pageAnalysis: PacketPageAnalysis,
  redactions: PacketRect[],
  previewEnabled: boolean,
  onChange: (r: PacketRect[]) => void,
  onApplyToPages: (r: PacketRect, targetPageNumbers: number[]) => void
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [baseScale, setBaseScale] = useState(1);
  const [zoom, setZoom] = useState(1);
  const [drawing, setDrawing] = useState<{ startX: number, startY: number, currX: number, currY: number } | null>(null);
  const [resizing, setResizing] = useState<{ index: number, startX: number, startY: number, startRect: PacketRect, mode: 'move' | 'se' } | null>(null);
  const [applyDialogOpen, setApplyDialogOpen] = useState(false);
  const [pendingApplyRect, setPendingApplyRect] = useState<PacketRect | null>(null);
  const [selectedApplyPages, setSelectedApplyPages] = useState<number[]>([]);

  useEffect(() => {
    if (!containerRef.current) return;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width } = entry.contentRect;
        setBaseScale(Math.max(0.2, Math.min((width - 32) / pageAnalysis.width, 1.5)));
      }
    });
    observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, [pageAnalysis.width, pageAnalysis.height]);

  const scale = baseScale * zoom;
  const otherPages = pageAnalyses.filter(page => page.pageNumber !== pageAnalysis.pageNumber);
  const sameDimensions = (page: PacketPageAnalysis) =>
    Math.abs(page.width - pageAnalysis.width) < 10 &&
    Math.abs(page.height - pageAnalysis.height) < 10;

  const openApplyDialog = (rect: PacketRect) => {
    setPendingApplyRect(rect);
    setSelectedApplyPages(
      otherPages
        .filter(page => sameDimensions(page) && page.pageType === pageAnalysis.pageType)
        .map(page => page.pageNumber),
    );
    setApplyDialogOpen(true);
  };

  const closeApplyDialog = () => {
    setApplyDialogOpen(false);
    setPendingApplyRect(null);
    setSelectedApplyPages([]);
  };

  const confirmApplyToPages = () => {
    if (!pendingApplyRect || selectedApplyPages.length === 0) return;
    onApplyToPages(pendingApplyRect, selectedApplyPages);
    closeApplyDialog();
  };

  const handlePointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest('button, [data-redaction-controls]')) return;

    const rect = e.currentTarget.getBoundingClientRect();
    const x = (e.clientX - rect.left) / scale;
    const y = (e.clientY - rect.top) / scale;

    const handle = (e.target as HTMLElement).closest('[data-resize-handle]') as HTMLElement | null;
    if (handle) {
      const index = parseInt(handle.dataset.index!, 10);
      const startRect = redactions[index];
      if (startRect) {
        setResizing({ index, startX: x, startY: y, startRect, mode: 'se' });
        e.currentTarget.setPointerCapture(e.pointerId);
        e.stopPropagation();
        return;
      }
    }

    const rectEl = (e.target as HTMLElement).closest('[data-rect-index]') as HTMLElement | null;
    if (rectEl) {
      const index = parseInt(rectEl.dataset.rectIndex!, 10);
      const startRect = redactions[index];
      if (startRect) {
        setResizing({ index, startX: x, startY: y, startRect, mode: 'move' });
        e.currentTarget.setPointerCapture(e.pointerId);
        e.stopPropagation();
        return;
      }
    }

    setDrawing({ startX: x, startY: y, currX: x, currY: y });
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = Math.max(0, Math.min(pageAnalysis.width, (e.clientX - rect.left) / scale));
    const y = Math.max(0, Math.min(pageAnalysis.height, (e.clientY - rect.top) / scale));

    if (resizing) {
      if (!resizing.startRect) return;
      const dx = x - resizing.startX;
      const dy = y - resizing.startY;
      const newRedactions = [...redactions];

      if (resizing.mode === 'move') {
        newRedactions[resizing.index] = {
          ...resizing.startRect,
          x: Math.max(0, Math.min(pageAnalysis.width - resizing.startRect.width, resizing.startRect.x + dx)),
          y: Math.max(0, Math.min(pageAnalysis.height - resizing.startRect.height, resizing.startRect.y + dy))
        };
      } else if (resizing.mode === 'se') {
        newRedactions[resizing.index] = {
          ...resizing.startRect,
          width: Math.max(10, Math.min(pageAnalysis.width - resizing.startRect.x, resizing.startRect.width + dx)),
          height: Math.max(10, Math.min(pageAnalysis.height - resizing.startRect.y, resizing.startRect.height + dy))
        };
      }
      onChange(newRedactions);
      return;
    }

    if (drawing) {
      setDrawing(prev => prev ? { ...prev, currX: x, currY: y } : null);
    }
  };

  const handlePointerUp = (e: React.PointerEvent) => {
    if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
    e.currentTarget.releasePointerCapture(e.pointerId);

    if (resizing) {
      setResizing(null);
      return;
    }

    if (drawing) {
      // Use the pointer-up coordinates directly. Some browsers and automation
      // drivers do not dispatch a final pointermove before pointerup.
      const bounds = e.currentTarget.getBoundingClientRect();
      const newRect = redactionFromDrag(
        { x: drawing.startX, y: drawing.startY },
        {
          x: (e.clientX - bounds.left) / scale,
          y: (e.clientY - bounds.top) / scale,
        },
        { width: pageAnalysis.width, height: pageAnalysis.height },
        // Treat a short screen-space movement as a drag at every zoom level.
        // A document-unit threshold made the same gesture fail on small pages
        // that had been scaled up to fit the editor.
        4 / scale,
      );
      if (newRect) {
        onChange([...redactions, newRect]);
      }
      setDrawing(null);
    }
  };

  return (
    <div ref={containerRef} className="w-full h-full flex flex-col items-center justify-start overflow-auto pb-8">
      <div className="flex gap-2 bg-card p-1.5 rounded-lg shadow-sm border border-border my-4 sticky top-4 z-10">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button type="button" variant="ghost" size="icon" aria-label="Zoom out" className="h-8 w-8" onClick={() => setZoom(s => Math.max(0.5, s - 0.25))}><ZoomOut className="w-4 h-4" /></Button>
          </TooltipTrigger>
          <TooltipContent>Zoom out</TooltipContent>
        </Tooltip>
        <div className="flex items-center justify-center w-12 text-xs font-bold" aria-live="polite">{Math.round(zoom * 100)}%</div>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button type="button" variant="ghost" size="icon" aria-label="Zoom in" className="h-8 w-8" onClick={() => setZoom(s => Math.min(3, s + 0.25))}><ZoomIn className="w-4 h-4" /></Button>
          </TooltipTrigger>
          <TooltipContent>Zoom in</TooltipContent>
        </Tooltip>
        <div
          className="flex items-center border-l border-border pl-2 pr-1 text-xs font-semibold text-muted-foreground"
          data-testid={`text-redaction-count-${packetId}-${pageAnalysis.pageNumber}`}
          aria-live="polite"
        >
          {redactions.length} {redactions.length === 1 ? "redaction" : "redactions"}
        </div>
      </div>

      <div
        className="relative bg-card shadow-lg border border-border cursor-crosshair touch-none shrink-0"
        style={{ width: pageAnalysis.width * scale, height: pageAnalysis.height * scale }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
      >
        <SourcePagePreview
          quoteId={quoteId}
          packetId={packetId}
          pageNumber={pageAnalysis.pageNumber}
          enabled={previewEnabled}
        />

        {redactions.map((r, i) => (
          <div
            key={i}
            data-rect-index={i}
            className={`absolute bg-slate-900 border border-slate-900 group ${resizing?.index === i ? 'z-20 cursor-grabbing' : 'z-10 cursor-grab hover:bg-slate-800'}`}
            style={{
              left: r.x * scale,
              top: r.y * scale,
              width: r.width * scale,
              height: r.height * scale,
            }}
          >
            <div
              data-redaction-controls
              role="group"
              className="absolute bottom-full left-0 z-30 flex gap-1 rounded-md bg-card p-1 shadow-md border border-border opacity-100 md:opacity-0 md:group-hover:opacity-100 transition-opacity pointer-events-auto mb-1"
              onPointerDown={e => e.stopPropagation()}
              onPointerUp={e => e.stopPropagation()}
              onClick={e => e.stopPropagation()}
            >
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    className="h-7 px-2 text-[10px] font-bold"
                    onClick={() => openApplyDialog(r)}
                  >
                    Apply to Pages
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Choose which other pages should receive this redaction box.</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    size="icon"
                    variant="destructive"
                    aria-label={`Remove redaction ${i + 1}`}
                    className="h-7 w-7 p-0"
                    onClick={() => onChange(redactions.filter((_, idx) => idx !== i))}
                  >
                    <X className="w-3 h-3" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Delete this redaction box.</TooltipContent>
              </Tooltip>
            </div>
            <div className="absolute inset-0 flex items-center justify-center text-slate-400 text-[10px] font-bold pointer-events-none overflow-hidden select-none">
              REDACTED
            </div>
            <div
              data-resize-handle
              data-index={i}
              className="absolute -bottom-1 -right-1 w-3 h-3 bg-card border border-slate-900 cursor-se-resize opacity-0 group-hover:opacity-100 touch-none shadow-sm"
            />
          </div>
        ))}

        {drawing && (
          <div
            className="absolute border-2 border-foreground bg-foreground/10 z-30 pointer-events-none"
            style={{
              left: Math.min(drawing.startX, drawing.currX) * scale,
              top: Math.min(drawing.startY, drawing.currY) * scale,
              width: Math.abs(drawing.currX - drawing.startX) * scale,
              height: Math.abs(drawing.currY - drawing.startY) * scale,
            }}
          />
        )}
      </div>

      <Dialog open={applyDialogOpen} onOpenChange={(open) => open ? setApplyDialogOpen(true) : closeApplyDialog()}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Apply redaction to other pages</DialogTitle>
            <DialogDescription>
              Choose the pages where this same redaction box belongs.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2 max-h-[300px] overflow-auto">
            {otherPages.map(page => {
              const sameSize = sameDimensions(page);
              const checked = selectedApplyPages.includes(page.pageNumber);
              const disabled = !sameSize;
              const checkboxId = `apply-redaction-page-${page.pageNumber}`;
              return (
                <div key={page.pageNumber} className={`flex items-start gap-3 rounded-md border p-3 ${disabled ? "border-border/60 bg-muted/40" : "border-border bg-card"}`}>
                  <Checkbox
                    id={checkboxId}
                    checked={checked}
                    disabled={disabled}
                    onCheckedChange={(nextChecked) => {
                      setSelectedApplyPages(current => nextChecked
                        ? (current.includes(page.pageNumber) ? current : [...current, page.pageNumber])
                        : current.filter(number => number !== page.pageNumber));
                    }}
                  />
                  <label htmlFor={checkboxId} className={`flex-1 text-sm ${disabled ? "cursor-not-allowed" : "cursor-pointer"}`}>
                    <span className="font-bold">Page {page.pageNumber}</span>
                  </label>
                </div>
              );
            })}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={closeApplyDialog}>Cancel</Button>
            <Button type="button" disabled={selectedApplyPages.length === 0} onClick={confirmApplyToPages}>
              Apply to selected pages
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function SourcePagePreview({ quoteId, packetId, pageNumber, enabled }: { quoteId: number, packetId: number, pageNumber: number, enabled: boolean }) {
  const { ref, visible } = usePreviewVisibility<HTMLDivElement>(enabled);
  return (
    <div ref={ref} className="absolute inset-0">
      {visible ? (
        <SourcePagePreviewRequest quoteId={quoteId} packetId={packetId} pageNumber={pageNumber} />
      ) : (
        <div className="absolute inset-0 bg-muted flex items-center justify-center text-muted-foreground font-medium">
          Preview loads when visible
        </div>
      )}
    </div>
  );
}

function SourcePagePreviewRequest({ quoteId, packetId, pageNumber }: { quoteId: number, packetId: number, pageNumber: number }) {
  const [attempt, setAttempt] = useState(0);
  const { data: blob, isLoading, isError } = useGetManufacturerPacketSourcePage(quoteId, packetId, pageNumber, {
    query: {
      retry: false,
      staleTime: Infinity,
      queryKey: [...getGetManufacturerPacketSourcePageQueryKey(quoteId, packetId, pageNumber), attempt],
      queryFn: ({ signal }) => previewFetchScheduler.run(
        () => getManufacturerPacketSourcePage(quoteId, packetId, pageNumber, { signal }), signal,
      ),
    },
  });
  const [objectUrl, setObjectUrl] = useState<string | null>(null);

  useEffect(() => {
    if (blob) {
      const url = URL.createObjectURL(blob);
      setObjectUrl(url);
      return () => URL.revokeObjectURL(url);
    }
    return undefined;
  }, [blob]);

  if (isLoading) {
    return <div className="absolute inset-0 flex items-center justify-center text-muted-foreground bg-muted/30"><Loader2 className="w-8 h-8 animate-spin" /></div>;
  }
  if (isError || !objectUrl) {
    return (
      <div className="absolute inset-0 flex flex-col gap-3 items-center justify-center bg-muted text-muted-foreground font-medium">
        <span>Source preview unavailable.</span>
        <Button type="button" variant="outline" size="sm" onClick={() => setAttempt(value => value + 1)} data-testid={`button-retry-source-preview-${packetId}-${pageNumber}`}>
          <RotateCcw className="w-4 h-4 mr-2" /> Retry preview
        </Button>
      </div>
    );
  }
  return <img src={objectUrl} alt={`Original manufacturer page ${pageNumber}`} className="absolute inset-0 w-full h-full pointer-events-none select-none object-contain bg-white" />;
}

function SanitizedPagePreview({ quoteId, packetId, pageNumber, enabled, revision }: { quoteId: number, packetId: number, pageNumber: number, enabled: boolean, revision: string }) {
  const { ref, visible } = usePreviewVisibility<HTMLDivElement>(enabled);
  return (
    <div ref={ref} className="w-full h-full">
      {visible ? (
        <SanitizedPagePreviewRequest key={revision} quoteId={quoteId} packetId={packetId} pageNumber={pageNumber} revision={revision} />
      ) : (
        <div className="flex flex-col items-center justify-center p-12 text-muted-foreground w-full h-full">
          <FileImage className="w-8 h-8 mb-4 opacity-40" />
          Preview loads when visible
        </div>
      )}
    </div>
  );
}

function SanitizedPagePreviewRequest({ quoteId, packetId, pageNumber, revision }: { quoteId: number, packetId: number, pageNumber: number, revision: string }) {
  const [attempt, setAttempt] = useState(0);
  const cleanedQueryKey = useMemo(
    () => cleanedManufacturerPacketPreviewQueryKey(quoteId, packetId, pageNumber, revision),
    [packetId, pageNumber, quoteId, revision],
  );
  const { data: blob, isLoading, isError } = useGetManufacturerPacketPage(quoteId, packetId, pageNumber, undefined, {
    query: {
      retry: false,
      staleTime: Infinity,
      queryKey: [...cleanedQueryKey, attempt],
      queryFn: ({ signal }) => previewFetchScheduler.run(
        () => getManufacturerPacketPage(quoteId, packetId, pageNumber, undefined, { signal }), signal,
      ),
    },
  });
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [scale, setScale] = useState(1);

  useEffect(() => {
    if (blob) {
      const url = URL.createObjectURL(blob);
      setObjectUrl(url);
      return () => URL.revokeObjectURL(url);
    }
    return undefined;
  }, [blob]);

  if (isLoading) {
    return <div className="flex flex-col items-center justify-center p-12 text-muted-foreground w-full h-full"><Loader2 className="w-8 h-8 animate-spin mb-4" /> Loading cleaned page {pageNumber}...</div>;
  }

  if (isError || !objectUrl) {
    return (
      <div className="text-destructive font-bold p-8 w-full h-full flex flex-col gap-4 items-center justify-center">
        <span>Failed to load preview for page {pageNumber}. Save redactions first.</span>
        <Button type="button" variant="outline" size="sm" onClick={() => setAttempt(value => value + 1)} data-testid={`button-retry-cleaned-preview-${packetId}-${pageNumber}`}>
          <RotateCcw className="w-4 h-4 mr-2" /> Retry preview
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center justify-start overflow-auto w-full h-full pb-8">
      <div className="flex gap-2 bg-card p-1.5 rounded-lg shadow-sm border border-border my-4 sticky top-4 z-10">
        <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => setScale(s => Math.max(0.25, s - 0.25))}><ZoomOut className="w-4 h-4" /></Button>
        <div className="flex items-center justify-center w-12 text-xs font-bold">{Math.round(scale * 100)}%</div>
        <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => setScale(s => Math.min(3, s + 0.25))}><ZoomIn className="w-4 h-4" /></Button>
      </div>
      <div className="bg-card shadow-lg border border-border overflow-hidden transition-transform duration-200 origin-top" style={{ transform: `scale(${scale})` }}>
        <img src={objectUrl} alt={`Generated preview page ${pageNumber}`} className="max-w-full h-auto block bg-white" />
      </div>
    </div>
  );
}