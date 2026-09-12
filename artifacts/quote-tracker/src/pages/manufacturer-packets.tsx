import { useState, useRef, useEffect } from "react";
import { useParams, Link } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Upload, FileText, Loader2, AlertTriangle, CheckCircle, RotateCcw, ZoomIn, ZoomOut, Save, X, Trash2, GripVertical, FileImage } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { Shell } from "@/components/layout";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { useToast } from "@/components/ui/toaster";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { 
  useGetQuote,
  useListManufacturerPackets, 
  getListManufacturerPacketsQueryKey,
  useRequestManufacturerPacketUpload,
  useCompleteManufacturerPacketUpload,
  useSetManufacturerPacketRedactions,
  useRetryManufacturerPacket,
  useGetManufacturerPacketPage,
  useGetManufacturerPacketSourcePage,
  useGetManufacturerPacketManifest,
  useSetManufacturerPacketManifest,
  useClearManufacturerPacketManifest,
  useDeleteManufacturerPacket,
  type ManufacturerPacket,
  type PacketPageAnalysis,
  type PacketRect
} from "@workspace/api-client-react";

export default function ManufacturerPacketsPage() {
  const { id } = useParams();
  const quoteId = parseInt(id || "0", 10);
  
  return (
    <Shell>
      <div className="mb-6">
        <Link href={`/quotes/${quoteId}`} className="inline-flex items-center text-sm font-bold text-muted-foreground hover:text-primary transition-colors mb-4">
          <ArrowLeft className="w-4 h-4 mr-1" /> Back to Quote
        </Link>
        <h1 className="text-3xl font-serif font-bold text-primary">Manufacturer Quotes</h1>
        <p className="text-muted-foreground mt-1">Upload, clean up, and publish manufacturer quote pages for customer review.</p>
      </div>
      <PacketsManager quoteId={quoteId} />
    </Shell>
  );
}

function PacketsManager({ quoteId }: { quoteId: number }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  
  const { data: packets = [], isLoading } = useListManufacturerPackets(quoteId, {
    query: {
      queryKey: getListManufacturerPacketsQueryKey(quoteId),
      refetchInterval: (query) => {
        const hasPending = query.state.data?.some(p => 
          p.status === "queued" || p.status === "processing"
        );
        return hasPending ? 2000 : false;
      }
    }
  });

  const { data: quoteDetail } = useGetQuote(quoteId);
  const quote = quoteDetail?.quote;

  const [activePacketId, setActivePacketId] = useState<number | 'manifest' | null>(null);
  
  useEffect(() => {
    if (packets.length > 0 && !activePacketId) {
      const pending = packets.find(p => p.status === "needs_review");
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
      ? "Review the suggested redactions on the quote marked Needs Review."
      : packets.some(packet => packet.status === "awaiting_upload" || packet.status === "queued" || packet.status === "processing")
        ? "Wait for the manufacturer quote to finish processing, then review it."
      : packets.some(packet => packet.status === "ready_for_approval")
        ? "Open the clean preview, then choose the pages your customer should see."
        : packets.some(packet => packet.status === "approved")
          ? "Choose and order customer pages, then publish the customer document."
          : "Review the manufacturer quote status and try again if processing failed.";
  
  const deletePacket = useDeleteManufacturerPacket();

  return (
    <>
      <WorkflowGuide
        quoteId={quoteId}
        quoteSigned={quote?.signed ?? false}
        hasPublishedDocument={packets.some(packet => packet.status === "approved")}
        nextStep={nextStep}
      />
      <div className="flex flex-col lg:flex-row gap-6">
        <div className="w-full lg:w-1/3 xl:w-1/4 space-y-4">
          <UploadCard quoteId={quoteId} />
        
        <button
          onClick={() => setActivePacketId('manifest')}
          data-testid="button-customer-document"
          aria-label="Open customer document pages"
          className={`w-full text-left p-4 rounded-lg border-2 transition-colors flex items-center justify-between ${
            activePacketId === 'manifest' 
              ? "border-primary bg-primary/5 shadow-sm" 
              : "border-border hover:border-primary/30 hover:bg-muted/50"
          }`}
        >
          <div>
            <div className="font-bold text-base">Customer Document</div>
            <div className="text-xs text-muted-foreground mt-0.5">Choose and order pages to publish</div>
          </div>
        </button>
        
        <Card>
          <CardHeader className="py-4">
            <CardTitle className="text-sm uppercase tracking-wider text-muted-foreground">Uploaded Manufacturer Quotes</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 pt-0 pb-4 px-4">
            {isLoading && <div className="text-center p-4"><Loader2 className="w-6 h-6 animate-spin mx-auto text-muted-foreground" /></div>}
            {!isLoading && packets.length === 0 && (
              <p className="text-sm text-muted-foreground text-center py-4">No manufacturer quotes uploaded yet.</p>
            )}
            {packets.map(packet => (
              <div key={packet.id} className="relative group">
                <button
                  onClick={() => setActivePacketId(packet.id)}
                  data-testid={`button-manufacturer-quote-${packet.id}`}
                  aria-label={`Open ${packet.originalName}`}
                  className={`w-full text-left p-3 pr-10 rounded-lg border-2 transition-colors ${
                    activePacketId === packet.id 
                      ? "border-primary bg-primary/5" 
                      : "border-border hover:border-primary/30 hover:bg-muted/50 bg-white"
                  }`}
                >
                  <div className="flex justify-between items-start mb-1">
                    <span className="font-bold text-sm truncate pr-2">{packet.originalName}</span>
                  </div>
                  <div className="text-xs text-muted-foreground flex justify-between items-center">
                    <span className="truncate pr-2">{packet.manufacturer || "Manufacturer not identified"}</span>
                    <StatusBadge status={packet.status} />
                  </div>
                </button>
                <Button 
                  size="icon" 
                  variant="ghost" 
                  type="button"
                  data-testid={`button-delete-manufacturer-quote-${packet.id}`}
                  aria-label={`Delete ${packet.originalName}`}
                  title="Delete this uploaded quote"
                  className="absolute right-1 top-1 h-8 w-8 text-muted-foreground hover:text-destructive opacity-100 md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100 transition-opacity"
                  onClick={(e) => {
                    e.stopPropagation();
                    if (confirm(`Delete this uploaded manufacturer quote? Any customer pages from it will be removed. ${quote?.signed ? "This quote is signed, so the customer will need to sign again." : "Only do this after a replacement is published."}`)) {
                      deletePacket.mutate({ id: quoteId, packetId: packet.id }, {
                        onSuccess: () => {
                          toast({ title: "Manufacturer quote deleted" });
                          queryClient.invalidateQueries({ queryKey: getListManufacturerPacketsQueryKey(quoteId) });
                          if (activePacketId === packet.id) setActivePacketId('manifest');
                        }
                      });
                    }
                  }}
                >
                  <Trash2 className="w-4 h-4" />
                </Button>
              </div>
            ))}
          </CardContent>
        </Card>
        </div>
      
        <div className="w-full lg:w-2/3 xl:w-3/4">
          {activePacketId === 'manifest' ? (
            <ManifestBuilder quoteId={quoteId} quoteSigned={quote?.signed ?? false} packets={packets.filter(p => p.status === 'ready_for_approval' || p.status === 'approved')} />
          ) : activePacket ? (
            <PacketDetails key={activePacket.id} quoteId={quoteId} packet={activePacket} />
          ) : (
            <Card className="h-full min-h-[400px] flex items-center justify-center border-dashed bg-muted/20">
              <div className="text-center max-w-md mx-auto p-6">
                <FileText className="w-12 h-12 text-muted-foreground/50 mx-auto mb-4" />
                <h3 className="text-lg font-bold text-foreground mb-2">No Selection</h3>
                <p className="text-sm text-muted-foreground">Select the customer document or an uploaded quote from the sidebar.</p>
              </div>
            </Card>
          )}
        </div>
      </div>
    </>
  );
}

function WorkflowGuide({ quoteId, quoteSigned, hasPublishedDocument, nextStep }: { quoteId: number; quoteSigned: boolean; hasPublishedDocument: boolean; nextStep: string }) {
  const steps = [
    ["1", "Upload a manufacturer quote", "Add the latest PDF. Keep the currently published document until a replacement is ready."],
    ["2", "Review and redact", "Check suggested private-detail boxes, then draw, move, or resize boxes where needed."],
    ["3", "Generate a clean preview", "Submit your redactions and review the cleaned pages before sharing anything."],
    ["4", "Choose customer pages", "Select only the pages the customer needs and arrange them in the right order."],
    ["5", "Publish the customer document", "Publishing makes the selected clean pages the customer-facing version."],
    ["6", "Customer signoff", "Open Signoff Document, share the no-login link, and ask the customer to review and sign."],
  ] as const;

  return (
    <Card className="mb-6 border-primary/20 bg-primary/5" data-testid="card-manufacturer-workflow">
      <CardHeader className="pb-3">
        <CardTitle className="text-xl">Six steps from quote PDF to customer signoff</CardTitle>
        <CardDescription>
          Follow the steps in order. A clean preview is never published until you choose the pages and click Publish Customer Document.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <ol className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {steps.map(([number, title, description]) => (
            <li key={number} className="flex gap-3 rounded-md border border-primary/15 bg-white/70 p-3">
              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary text-sm font-bold text-primary-foreground" aria-hidden="true">
                {number}
              </span>
              <div>
                <h3 className="font-bold text-foreground">{title}</h3>
                <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{description}</p>
              </div>
            </li>
          ))}
        </ol>
        <div className="rounded-md border border-primary/20 bg-white p-3 text-sm text-foreground" data-testid="text-manufacturer-next-step">
          <strong>Next step:</strong> {nextStep}
          {hasPublishedDocument && (
            <Link href={`/quotes/${quoteId}/signoff`} className="ml-2 font-bold text-primary underline underline-offset-2 hover:no-underline" data-testid="link-open-signoff-document">
              Open Signoff Document
            </Link>
          )}
        </div>
        <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950" data-testid="card-manufacturer-replacement-guidance">
          <h3 className="font-bold">Replacing a changed manufacturer quote</h3>
          <p className="mt-1">
            Upload the replacement as a new quote and keep the old published pages in place while you review and clean the replacement.
            When the replacement is ready, choose its pages and publish the customer document; that single publish swaps the customer-facing pages.
            Only then delete the old uploaded quote if you no longer need it.
          </p>
          <p className="mt-2 font-medium">
            {quoteSigned
              ? "This quote is already signed. Publishing a replacement removes that signature, so the customer must review the new document and sign again."
              : "If the customer signs before you publish a replacement, the replacement will require the customer to review and sign again."}
          </p>
          <p className="mt-2">
            Deleting an uploaded quote can also remove the current signoff, even when its pages are no longer selected. Keep old quotes for the record unless you are ready to request another signature.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, { label: string, className: string }> = {
    awaiting_upload: { label: "Uploading", className: "bg-gray-100 text-gray-800" },
    queued: { label: "Queued", className: "bg-blue-100 text-blue-800" },
    processing: { label: "Processing", className: "bg-blue-100 text-blue-800" },
    needs_review: { label: "Needs Review", className: "bg-amber-100 text-amber-800" },
    ready_for_approval: { label: "Clean Preview Ready", className: "bg-purple-100 text-purple-800" },
    approved: { label: "Published", className: "bg-green-100 text-green-800" },
    failed: { label: "Failed", className: "bg-red-100 text-red-800" },
  };
  const m = map[status] || { label: status, className: "bg-gray-100 text-gray-800" };
  return <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full uppercase tracking-wider ${m.className}`}>{m.label}</span>;
}

function UploadCard({ quoteId }: { quoteId: number }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isUploading, setIsUploading] = useState(false);
  const requestUpload = useRequestManufacturerPacketUpload();
  const completeUpload = useCompleteManufacturerPacketUpload();

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    
    setIsUploading(true);
    try {
      const req = await requestUpload.mutateAsync({
        id: quoteId,
        data: {
          name: file.name,
          size: file.size,
          contentType: "application/pdf" as const,
          manufacturer: null // Backend handles detection or we let user specify later
        }
      });
      
      // PUT file
      const res = await fetch(req.uploadURL, {
        method: "PUT",
        headers: { "Content-Type": file.type || "application/pdf" },
        body: file
      });
      
      if (!res.ok) throw new Error("Upload failed");
      
      // Complete
      await completeUpload.mutateAsync({
        id: quoteId,
        packetId: req.packet.id
      });
      
       toast({ title: "Manufacturer quote uploaded", description: "Processing started. We will mark it ready for review when analysis finishes." });
      queryClient.invalidateQueries({ queryKey: getListManufacturerPacketsQueryKey(quoteId) });
    } catch (err: any) {
      toast({ title: "Upload error", description: err.message || "Failed to upload the manufacturer quote.", variant: "destructive" });
    } finally {
      setIsUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Step 1: Upload a quote</CardTitle>
        <CardDescription className="text-xs">Choose the manufacturer PDF you received. You can prepare a replacement without changing the current customer document.</CardDescription>
      </CardHeader>
      <CardContent className="pt-0 p-4">
        <input 
          ref={fileInputRef}
          type="file" 
          accept="application/pdf" 
          className="hidden" 
          onChange={handleFileChange}
          disabled={isUploading}
        />
        <Button 
          className="w-full font-bold" 
          type="button"
          data-testid="button-upload-manufacturer-quote"
          title="Upload a manufacturer quote PDF"
          disabled={isUploading}
          onClick={() => fileInputRef.current?.click()}
        >
          {isUploading ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Upload className="w-4 h-4 mr-2" />}
          {isUploading ? "Uploading..." : "Upload New Manufacturer Quote"}
        </Button>
      </CardContent>
    </Card>
  );
}

function PacketDetails({ quoteId, packet }: { quoteId: number, packet: ManufacturerPacket }) {
  if (packet.status === "queued" || packet.status === "processing") {
    return (
      <Card className="h-full flex flex-col items-center justify-center p-12 text-center border-dashed">
        <Loader2 className="w-12 h-12 animate-spin text-primary mb-4" />
        <h3 className="text-xl font-bold mb-2">Analyzing Manufacturer Quote...</h3>
        <p className="text-muted-foreground max-w-md">
          The system is extracting pages, detecting layouts, and finding areas to redact. This usually takes a few moments.
        </p>
      </Card>
    );
  }

  if (packet.status === "failed") {
    return <PacketFailed quoteId={quoteId} packet={packet} />;
  }

  if (packet.status === "needs_review" || packet.status === "ready_for_approval") {
    return <PacketReview key={packet.id} quoteId={quoteId} packet={packet} />;
  }

  if (packet.status === "approved") {
    return (
      <Card className="h-full flex flex-col items-center justify-center p-12 text-center border-green-200 bg-green-50/50">
        <CheckCircle className="w-16 h-16 text-green-600 mb-4" />
        <h3 className="text-2xl font-bold text-green-900 mb-2">Quote ready for customer pages</h3>
        <p className="text-green-700 max-w-md">
          This quote has a clean preview and is included in the customer document. Open Customer Document to choose or reorder its pages.
        </p>
      </Card>
    );
  }

  return null;
}

function PacketFailed({ quoteId, packet }: { quoteId: number, packet: ManufacturerPacket }) {
  const queryClient = useQueryClient();
  const retry = useRetryManufacturerPacket();
  
  return (
    <Card className="border-destructive">
      <CardHeader>
        <CardTitle className="text-destructive flex items-center">
          <AlertTriangle className="w-5 h-5 mr-2" /> Processing Failed
        </CardTitle>
      </CardHeader>
      <CardContent>
        <p className="text-muted-foreground mb-6">
          {packet.failureMessage || "An unknown error occurred while analyzing the document."}
        </p>
        <Button 
          type="button"
          variant="outline" 
          data-testid="button-retry-manufacturer-quote"
          title="Try analyzing this manufacturer quote again"
          disabled={retry.isPending}
          onClick={() => {
            retry.mutate({ id: quoteId, packetId: packet.id }, {
              onSuccess: () => {
                queryClient.invalidateQueries({ queryKey: getListManufacturerPacketsQueryKey(quoteId) });
              }
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



function PacketReview({ quoteId, packet }: { quoteId: number, packet: ManufacturerPacket }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const submitRedactions = useSetManufacturerPacketRedactions();
  
  const analysis = packet.analysis || [];
  
  const [redactions, setRedactions] = useState<Record<string, PacketRect[]>>(() => {
    const init: Record<string, PacketRect[]> = {};
    if (packet.manualRedactions) {
      Object.assign(init, packet.manualRedactions);
    } else {
      analysis.forEach(a => {
        init[a.pageNumber.toString()] = [...a.suggestedRects];
      });
    }
    return init;
  });
  
  const [currentPageNum, setCurrentPageNum] = useState<number>(analysis[0]?.pageNumber || 1);
  const [viewMode, setViewMode] = useState<'source' | 'cleaned'>('source');
  
  const currentPage = analysis.find(a => a.pageNumber === currentPageNum);
  const pageRedactions = redactions[currentPageNum.toString()] || [];
  
  const handleSave = () => {
    submitRedactions.mutate({
      id: quoteId,
      packetId: packet.id,
      data: { redactionsByPage: redactions }
    }, {
      onSuccess: () => {
        toast({ title: "Redactions submitted", description: "The clean preview is being generated." });
        queryClient.invalidateQueries({ queryKey: getListManufacturerPacketsQueryKey(quoteId) });
      },
      onError: (err: any) => {
        toast({ title: "Submission failed", description: err.message || "Failed to submit redactions.", variant: "destructive" });
      }
    });
  };

  if (analysis.length === 0) {
    return (
      <Card>
        <CardContent className="p-8 text-center text-muted-foreground">
          No page analysis data found for this packet.
        </CardContent>
      </Card>
    );
  }

  const isUnknown = !packet.detectedManufacturer ||
    packet.detectedManufacturer === "unknown" ||
    currentPage?.pageType === "unknown" || currentPage?.pageType === "manual";

  return (
    <Card className="h-full flex flex-col overflow-hidden">
      <CardHeader className="bg-muted/30 border-b pb-4 flex flex-row items-center justify-between">
        <div>
          <CardTitle>Step 2: Review & Redact</CardTitle>
          <CardDescription>
            {packet.status === "ready_for_approval"
              ? "Step 3 is ready: review the clean preview, or return to the editor to correct boxes and generate it again. When satisfied, choose pages in Customer Document."
              : "Review suggested removals and draw or resize boxes over private administrative details. Then submit them to generate a clean preview."}
          </CardDescription>
        </div>
        <div className="flex gap-4 items-center">
          <div className="flex items-center gap-2 bg-white rounded-md border p-1">
            <Button size="sm" type="button" data-testid="button-redaction-editor" title="Draw and adjust redaction boxes" variant={viewMode === 'source' ? 'default' : 'ghost'} onClick={() => setViewMode('source')}>Editor</Button>
            <Button size="sm" type="button" data-testid="button-clean-preview" title={packet.status === "ready_for_approval" ? "View the generated clean preview" : "Submit redactions first to generate a clean preview"} disabled={packet.status !== "ready_for_approval"} variant={viewMode === 'cleaned' ? 'default' : 'ghost'} onClick={() => setViewMode('cleaned')}>Clean Preview</Button>
          </div>
          <Button type="button" data-testid="button-generate-clean-preview" title="Submit redactions and generate the clean preview" onClick={handleSave} disabled={submitRedactions.isPending} className="bg-black text-white">
            {submitRedactions.isPending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Save className="w-4 h-4 mr-2" />}
            {packet.status === "ready_for_approval" ? "Generate Again" : "Generate Clean Preview"}
          </Button>
        </div>
      </CardHeader>
      
      <div className="flex flex-1 overflow-hidden">
        <div className="w-48 border-r bg-muted/10 overflow-y-auto p-2 space-y-2">
          {analysis.map(a => (
            <button
              key={a.pageNumber}
              type="button"
              data-testid={`button-review-page-${a.pageNumber}`}
              aria-label={`Page ${a.pageNumber} — Review page`}
              title={`Review page ${a.pageNumber}${a.pageType === "unknown" ? " (layout needs manual review)" : ""}`}
              onClick={() => setCurrentPageNum(a.pageNumber)}
              className={`w-full text-left p-2 rounded text-sm transition-colors ${
                currentPageNum === a.pageNumber 
                  ? "bg-primary text-primary-foreground font-bold" 
                  : "hover:bg-muted font-medium"
              }`}
            >
              Page {a.pageNumber}
              {a.pageType === "unknown" && (
                <span title="Unknown layout">
                  <AlertTriangle className="w-3 h-3 inline-block ml-2 opacity-70" />
                </span>
              )}
            </button>
          ))}
        </div>
        
        <div className="flex-1 flex flex-col bg-slate-50 relative overflow-hidden">
          {isUnknown && viewMode === 'source' && (
            <div className="bg-amber-100 text-amber-800 p-2 text-sm font-bold text-center border-b border-amber-200">
              <AlertTriangle className="w-4 h-4 inline-block mr-2 -mt-0.5" />
              Unknown layout detected. Please verify redactions manually.
            </div>
          )}
          
          <div className="flex-1 overflow-auto p-4 flex items-start justify-center">
             {currentPage && viewMode === 'source' && (
                <PageRedactionEditor
                  key={`${packet.id}:${currentPage.pageNumber}`}
                  quoteId={quoteId}
                  packetId={packet.id}
                  pageAnalyses={analysis}
                  pageAnalysis={currentPage}
                  redactions={pageRedactions}
                  onChange={(newRedactions) => {
                    setRedactions(prev => ({ ...prev, [currentPage.pageNumber.toString()]: newRedactions }));
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
                   setRedactions(newMap);
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
               <SanitizedPagePreview quoteId={quoteId} packetId={packet.id} pageNumber={currentPage.pageNumber} />
             )}
          </div>
        </div>
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
  onChange,
  onApplyToPages
}: { 
  quoteId: number,
  packetId: number,
  pageAnalyses: PacketPageAnalysis[],
  pageAnalysis: PacketPageAnalysis, 
  redactions: PacketRect[], 
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

  const { data: sourceBlob, isLoading: sourceLoading } = useGetManufacturerPacketSourcePage(quoteId, packetId, pageAnalysis.pageNumber);
  const [sourceUrl, setSourceUrl] = useState<string | null>(null);

  useEffect(() => {
    if (sourceBlob) {
      const u = URL.createObjectURL(sourceBlob);
      setSourceUrl(u);
      return () => URL.revokeObjectURL(u);
    }
    return undefined;
  }, [sourceBlob]);

  useEffect(() => {
    if (!containerRef.current) return;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width } = entry.contentRect;
        // Fit the available width, not our own content-driven height: using
        // that height feeds shrinking page dimensions back into this observer.
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
    if ((e.target as HTMLElement).closest('button, [data-redaction-controls]')) return; // ignore UI controls
    
    const rect = e.currentTarget.getBoundingClientRect();
    const x = (e.clientX - rect.left) / scale;
    const y = (e.clientY - rect.top) / scale;

    // Check if clicked a resize handle
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

    // Check if clicked inside an existing rect to move it
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

    // Otherwise, start drawing new rect
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
    // Redaction action buttons stop pointerdown propagation, so there is no
    // capture to release for their pointerup. Calling releasePointerCapture
    // without a capture throws in some browsers and prevents their click from
    // firing, especially on touch screens.
    if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
    e.currentTarget.releasePointerCapture(e.pointerId);
    
    if (resizing) {
      setResizing(null);
      return;
    }

    if (drawing) {
      const w = Math.abs(drawing.currX - drawing.startX);
      const h = Math.abs(drawing.currY - drawing.startY);
      if (w > 10 && h > 10) {
        const newRect = {
          x: Math.min(drawing.startX, drawing.currX),
          y: Math.min(drawing.startY, drawing.currY),
          width: w,
          height: h,
          reason: "Manual Redaction"
        };
        onChange([...redactions, newRect]);
      }
      setDrawing(null);
    }
  };

  return (
    <div ref={containerRef} className="w-full min-h-[600px] flex flex-col items-center justify-start overflow-auto">
      <div className="flex gap-2 bg-white p-2 rounded-lg shadow-sm border mb-4 sticky top-0 z-10">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button type="button" variant="outline" size="icon" data-testid="button-redaction-zoom-out" aria-label="Zoom out" title="Zoom out" onClick={() => setZoom(s => Math.max(0.5, s - 0.25))}><ZoomOut className="w-4 h-4" /></Button>
          </TooltipTrigger>
          <TooltipContent>Zoom out</TooltipContent>
        </Tooltip>
        <div className="flex items-center justify-center w-16 text-sm font-medium" aria-live="polite">{Math.round(zoom * 100)}%</div>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button type="button" variant="outline" size="icon" data-testid="button-redaction-zoom-in" aria-label="Zoom in" title="Zoom in" onClick={() => setZoom(s => Math.min(3, s + 0.25))}><ZoomIn className="w-4 h-4" /></Button>
          </TooltipTrigger>
          <TooltipContent>Zoom in</TooltipContent>
        </Tooltip>
      </div>

      <div 
        className="relative bg-white shadow-xl border border-gray-200 cursor-crosshair touch-none shrink-0"
        style={{ 
          width: pageAnalysis.width * scale, 
          height: pageAnalysis.height * scale 
        }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
      >
        {sourceUrl ? (
          <img src={sourceUrl} alt={`Original manufacturer page ${pageAnalysis.pageNumber}`} className="absolute inset-0 w-full h-full pointer-events-none select-none" />
        ) : sourceLoading ? (
          <div className="absolute inset-0 flex items-center justify-center text-muted-foreground"><Loader2 className="w-8 h-8 animate-spin" /></div>
        ) : (
          <div className="absolute inset-0 bg-gray-100 flex items-center justify-center text-gray-400">Missing source</div>
        )}

        {redactions.map((r, i) => (
          <div
            key={i}
            data-rect-index={i}
            className={`absolute bg-black/80 border-2 border-black group ${resizing?.index === i ? 'z-20 cursor-grabbing' : 'z-10 cursor-grab hover:bg-black/90'}`}
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
              aria-label={`Controls for redaction ${i + 1}`}
              className="absolute bottom-full left-0 z-30 flex gap-1 rounded-md bg-white p-1 shadow-md border opacity-100 md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100 transition-opacity pointer-events-auto"
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
                    data-testid={`button-redaction-apply-similar-${i}`}
                    className="h-7 px-2 text-[10px]"
                    onClick={() => openApplyDialog(r)}
                    aria-label="Apply this redaction to other pages"
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
                    data-testid={`button-redaction-remove-${i}`}
                    className="h-7 w-7 p-0"
                    onClick={() => onChange(redactions.filter((_, idx) => idx !== i))}
                    aria-label={`Delete redaction ${i + 1}`}
                  >
                    <X className="w-3 h-3" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Delete this redaction box.</TooltipContent>
              </Tooltip>
            </div>
            <div className="absolute inset-0 flex items-center justify-center text-white/50 text-xs font-mono pointer-events-none overflow-hidden">
              REDACTED
            </div>
            {/* SE Resize Handle */}
            <div 
              data-resize-handle
              data-index={i}
              className="absolute -bottom-1 -right-1 w-3 h-3 bg-white border border-black cursor-se-resize opacity-0 group-hover:opacity-100 touch-none"
            />
          </div>
        ))}

        {drawing && (
          <div
            className="absolute border-2 border-red-500 bg-red-500/20 z-30 pointer-events-none"
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
        <DialogContent data-testid="dialog-apply-redaction">
          <DialogHeader>
            <DialogTitle>Apply redaction to other pages</DialogTitle>
            <DialogDescription>
              Choose the pages where this same redaction box belongs. Pages with the same detected layout and size are preselected; review any different layout before selecting it.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2" role="group" aria-label="Pages available for this redaction">
            {otherPages.map(page => {
              const sameSize = sameDimensions(page);
              const sameLayout = page.pageType === pageAnalysis.pageType;
              const checked = selectedApplyPages.includes(page.pageNumber);
              const disabled = !sameSize;
              const checkboxId = `apply-redaction-page-${page.pageNumber}`;
              return (
                <div key={page.pageNumber} className={`flex items-start gap-3 rounded-md border p-3 ${disabled ? "border-border/60 bg-muted/40" : "border-border bg-card"}`}>
                  <Checkbox
                    id={checkboxId}
                    data-testid={`checkbox-apply-redaction-page-${page.pageNumber}`}
                    aria-label={`Page ${page.pageNumber}`}
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
                    <span className="block text-xs text-muted-foreground">
                      {disabled
                        ? "Different page size — review this page manually."
                        : sameLayout
                          ? "Same page size and detected layout — preselected."
                          : "Same page size, different detected layout — review manually."}
                    </span>
                  </label>
                </div>
              );
            })}
            {otherPages.length === 0 && (
              <p className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">
                There are no other pages in this quote.
              </p>
            )}
            {otherPages.some(page => !sameDimensions(page)) && (
              <p className="text-xs text-amber-700" role="alert">
                Different-size pages are disabled because this box may not fit. Add a redaction manually on those pages.
              </p>
            )}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" data-testid="button-cancel-apply-redaction" onClick={closeApplyDialog}>
              Cancel
            </Button>
            <Button
              type="button"
              data-testid="button-confirm-apply-redaction"
              disabled={selectedApplyPages.length === 0}
              onClick={confirmApplyToPages}
            >
              Apply to selected pages
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function SanitizedPagePreview({ quoteId, packetId, pageNumber }: { quoteId: number, packetId: number, pageNumber: number }) {
  const { data: blob, isLoading, isError } = useGetManufacturerPacketPage(quoteId, packetId, pageNumber);
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
    return <div className="flex flex-col items-center p-12 text-muted-foreground w-full h-full"><Loader2 className="w-8 h-8 animate-spin mb-4" /> Loading cleaned page {pageNumber}...</div>;
  }

  if (isError || !objectUrl) {
    return <div className="text-destructive font-bold p-8 w-full h-full flex items-center justify-center">Failed to load preview for page {pageNumber}. Save redactions first.</div>;
  }

  return (
    <div className="flex flex-col items-center justify-start overflow-auto w-full h-full">

      <div className="flex gap-2 bg-white p-2 rounded-lg shadow-sm border mb-2">
        <Button variant="outline" size="icon" onClick={() => setScale(s => Math.max(0.25, s - 0.25))}><ZoomOut className="w-4 h-4" /></Button>
        <div className="flex items-center justify-center w-16 text-sm font-medium">{Math.round(scale * 100)}%</div>
        <Button variant="outline" size="icon" onClick={() => setScale(s => Math.min(3, s + 0.25))}><ZoomIn className="w-4 h-4" /></Button>
      </div>
      <div className="bg-white shadow-xl border border-gray-200 overflow-hidden transition-transform duration-200 origin-top" style={{ transform: `scale(${scale})` }}>
        <img src={objectUrl} alt={`Page ${pageNumber}`} className="max-w-full h-auto block" />
      </div>
    </div>
  );
}


function ManifestBuilder({ quoteId, quoteSigned, packets }: { quoteId: number, quoteSigned: boolean, packets: ManufacturerPacket[] }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data: manifest, isLoading } = useGetManufacturerPacketManifest(quoteId);
  const setManifest = useSetManufacturerPacketManifest();
  const deleteManifest = useClearManufacturerPacketManifest();

  const [entries, setEntries] = useState<{packetId: number, pageNumber: number, id: string}[]>([]);
  const [policyConfirmed, setPolicyConfirmed] = useState(false);

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
    if (quoteSigned && !confirm("This quote is signed. Changing the published customer pages removes the customer's signature. They will need to review and sign again. Continue?")) {
      return;
    }
    
    setManifest.mutate({
      id: quoteId,
      data: {
        entries: entries.map((e, idx) => ({
          packetId: e.packetId,
          pageNumber: e.pageNumber,
          pageOrder: idx + 1
        }))
      }
    }, {
      onSuccess: () => {
        toast({ title: "Customer document published", description: "The selected clean pages are now ready for customer review and signoff." });
        queryClient.invalidateQueries({ queryKey: getListManufacturerPacketsQueryKey(quoteId) });
      },
      onError: (err: any) => {
        toast({ title: "Publish failed", description: err.message, variant: "destructive" });
      }
    });
  };

  const handleUnpublish = () => {
    if (quoteSigned && !confirm("This quote is signed. Removing the published customer pages removes the customer's signature. They will need to sign again after you publish a new document. Continue?")) {
      return;
    }
    deleteManifest.mutate({ id: quoteId }, {
      onSuccess: () => {
        toast({ title: "Customer document removed", description: "Publish a new set of clean pages before sending the quote for signoff." });
        queryClient.invalidateQueries({ queryKey: getListManufacturerPacketsQueryKey(quoteId) });
      }
    });
  };

  const moveUp = (index: number) => {
    if (index === 0) return;
    const newEntries = [...entries];
    [newEntries[index - 1], newEntries[index]] = [newEntries[index], newEntries[index - 1]];
    setEntries(newEntries);
  };
  
  const moveDown = (index: number) => {
    if (index === entries.length - 1) return;
    const newEntries = [...entries];
    [newEntries[index + 1], newEntries[index]] = [newEntries[index], newEntries[index + 1]];
    setEntries(newEntries);
  };

  const removeEntry = (index: number) => {
    const newEntries = [...entries];
    newEntries.splice(index, 1);
    setEntries(newEntries);
  };

  const addAllFromPacket = (packet: ManufacturerPacket) => {
    const newEntries = [...entries];
    for (let i = 1; i <= (packet.pageCount || 0); i++) {
      newEntries.push({ packetId: packet.id, pageNumber: i, id: `${packet.id}-${i}-${Math.random()}` });
    }
    setEntries(newEntries);
  };

  if (isLoading) {
    return <Card className="h-full flex items-center justify-center p-12"><Loader2 className="w-8 h-8 animate-spin text-muted-foreground" /></Card>;
  }

  return (
    <Card className="h-full flex flex-col overflow-hidden">
      <CardHeader className="bg-muted/30 border-b pb-4 flex flex-col lg:flex-row lg:items-center justify-between gap-4">
        <div>
          <CardTitle>Step 4: Customer Document Pages</CardTitle>
          <CardDescription>Select and order clean pages across manufacturer quotes. These are the pages customers will see and sign.</CardDescription>
        </div>
        <div className="flex flex-col items-end gap-2">
          {entries.length > 0 && (
            <div className="flex items-center space-x-2 bg-white/50 p-2 rounded border">
              <Checkbox id="policy" data-testid="checkbox-preserved-terms" aria-label="Confirm prices, terms, and warranties are preserved" checked={policyConfirmed} onCheckedChange={(c) => setPolicyConfirmed(!!c)} />
              <label htmlFor="policy" className="text-xs font-medium leading-none cursor-pointer">
                I checked that prices, terms, and warranties are preserved
              </label>
            </div>
          )}
          <div className="flex gap-2">
            {manifest?.entries?.length ? (
              <Button type="button" variant="outline" data-testid="button-remove-customer-document" title="Remove the currently published customer document" onClick={handleUnpublish} disabled={deleteManifest.isPending} className="text-destructive hover:text-destructive">
                Remove Published Document
              </Button>
            ) : null}
            <Button type="button" data-testid="button-publish-customer-document" title="Publish the selected clean pages for customer review and signoff" onClick={handleSave} className="bg-green-700 hover:bg-green-800 text-white" disabled={setManifest.isPending || (entries.length > 0 && !policyConfirmed)}>
              {setManifest.isPending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Save className="w-4 h-4 mr-2" />}
              Publish Customer Document
            </Button>
          </div>
        </div>
      </CardHeader>
      {quoteSigned && (
        <div className="mx-6 mt-4 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950" role="alert" data-testid="alert-customer-document-resign">
          <strong>Re-sign warning:</strong> Publishing a different set or order of pages changes the signoff document and removes the current customer signature. After publishing, open Signoff Document and share the updated link for a new signoff.
        </div>
      )}
      
      <div className="flex flex-1 overflow-hidden">
        <div className="w-64 border-r bg-muted/10 overflow-y-auto p-4 space-y-4">
          <h3 className="font-bold text-sm uppercase tracking-widest text-muted-foreground mb-2">Clean Manufacturer Quotes</h3>
          {packets.length === 0 && (
            <p className="text-xs text-muted-foreground italic">No clean previews ready yet. Finish review first.</p>
          )}
          {packets.map(p => (
            <div key={p.id} className="bg-white p-3 rounded border shadow-sm space-y-2">
              <div className="font-bold text-sm truncate" title={p.originalName}>{p.originalName}</div>
              <div className="text-xs text-muted-foreground">{p.pageCount} pages</div>
              <Button type="button" size="sm" variant="secondary" data-testid={`button-add-all-pages-${p.id}`} title={`Add every clean page from ${p.originalName}`} className="w-full text-xs" onClick={() => addAllFromPacket(p)}>
                Add all pages
              </Button>
            </div>
          ))}
        </div>
        
        <div className="flex-1 bg-slate-50 overflow-auto p-6">
          <h3 className="font-bold text-sm uppercase tracking-widest text-muted-foreground mb-4">Customer page order ({entries.length} pages)</h3>
          
          {entries.length === 0 ? (
            <div className="text-center p-12 border-2 border-dashed rounded-lg text-muted-foreground">
              <FileText className="w-12 h-12 mx-auto mb-4 opacity-50" />
              <p>No customer pages selected.</p>
              <p className="text-sm mt-2">Add clean pages from the manufacturer quotes on the left.</p>
            </div>
          ) : (
            <div className="space-y-3">
              {entries.map((entry, idx) => {
                const p = packets.find(x => x.id === entry.packetId);
                return (
                  <div key={entry.id} className="flex items-center gap-3 bg-white p-3 rounded-lg border shadow-sm">
                    <div className="flex flex-col gap-1">
                      <Button type="button" size="icon" variant="ghost" className="h-6 w-6" data-testid={`button-move-customer-page-up-${idx}`} aria-label={`Move customer page ${idx + 1} up`} title="Move page up" onClick={() => moveUp(idx)} disabled={idx === 0}>▲</Button>
                      <Button type="button" size="icon" variant="ghost" className="h-6 w-6" data-testid={`button-move-customer-page-down-${idx}`} aria-label={`Move customer page ${idx + 1} down`} title="Move page down" onClick={() => moveDown(idx)} disabled={idx === entries.length - 1}>▼</Button>
                    </div>
                    
                    <div className="w-16 h-20 shrink-0 border bg-gray-100 flex items-center justify-center overflow-hidden">
                       <MiniPreview quoteId={quoteId} packetId={entry.packetId} pageNumber={entry.pageNumber} />
                    </div>
                    
                    <div className="flex-1 min-w-0">
                      <div className="font-bold text-sm truncate">{p?.originalName || "Unknown packet"}</div>
                      <div className="text-xs text-muted-foreground">Page {entry.pageNumber}</div>
                    </div>
                    
                    <Button type="button" size="icon" variant="ghost" data-testid={`button-remove-customer-page-${idx}`} aria-label={`Remove customer page ${idx + 1}`} title="Remove page from customer document" className="text-destructive hover:text-destructive h-8 w-8" onClick={() => removeEntry(idx)}>
                      <X className="w-4 h-4" />
                    </Button>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </Card>
  );
}

function MiniPreview({ quoteId, packetId, pageNumber }: { quoteId: number, packetId: number, pageNumber: number }) {
  const { data: blob } = useGetManufacturerPacketPage(quoteId, packetId, pageNumber);
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (blob) {
      const u = URL.createObjectURL(blob);
      setUrl(u);
      return () => URL.revokeObjectURL(u);
    }
    return undefined;
  }, [blob]);
  return url ? <img src={url} alt={`Clean page ${pageNumber} preview`} className="w-full h-full object-cover" /> : <Loader2 aria-label="Loading page preview" className="w-4 h-4 animate-spin text-muted-foreground" />;
}
