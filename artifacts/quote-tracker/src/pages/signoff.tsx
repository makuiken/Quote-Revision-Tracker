import { useEffect, useRef, useState } from "react";
import { Link, useParams } from "wouter";
import { Check, Copy, Download, ExternalLink, Mail, Share2, ArrowLeft, PenTool, CheckCircle, AlertTriangle, RotateCcw, Clock, XCircle } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import {
  getGetQuoteQueryKey,
  getGetShareInfoQueryKey,
  getListScopedApprovalsQueryKey,
  useCancelScopedApproval,
  useCreateScopedApproval,
  useGetQuote,
  useGetShareInfo,
  useListScopedApprovals,
  useSetRevisionSignoffExclusion,
  useRotateScopedApprovalLink,
  useUpdateScopedApprovalLink,
  useCreateShareLink,
  useUpdateShareLink,
  useRevokeShareLink,
  useRotateShareLink,
  getSignedSignoffDocument,
  type QuoteCategoriesItem,
  type ShareLink,
  type ScopedApproval,
  type ScopedApprovalsResponse,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/components/ui/toaster";
import { categoryLabel } from "@/lib/revision-categories";
import { useScopedApprovalDocument } from "@/lib/scoped-approval-document";

function scopedLinkAccessStatus(approval: ScopedApproval): "active" | "expired" | "revoked" {
  if (approval.revokedAt) return "revoked";
  if (approval.expiresAt && new Date(approval.expiresAt).getTime() <= Date.now()) return "expired";
  return "active";
}

function ScopedShareDialog({
  approval,
  quoteNumber,
  customerName,
  open,
  onOpenChange,
}: {
  approval: ScopedApproval | null;
  quoteNumber: string;
  customerName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [email, setEmail] = useState("");
  const [copied, setCopied] = useState(false);
  const { data: shareInfo } = useGetShareInfo({ query: { enabled: open, queryKey: getGetShareInfoQueryKey() } });
  const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");
  const origin = shareInfo?.publicOrigin ?? window.location.origin;
  const url = approval ? `${origin}${basePath}/scoped-sign/${approval.token}` : "";
  const scope = approval?.productTypes.map(categoryLabel).join(", ") ?? "";
  const mailto = `mailto:${email}?subject=${encodeURIComponent(`Approval requested – Quote #${quoteNumber}`)}&body=${encodeURIComponent(`Hi ${customerName},\n\nPlease review and approve ${scope} for Quote #${quoteNumber}.\n\n${url}\n\nThis link includes only the product types listed above.\n\nThank you,\nKuiken Brothers`)}`;

  const copy = async () => {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      const input = document.createElement("textarea");
      input.value = url;
      document.body.appendChild(input);
      input.select();
      document.execCommand("copy");
      input.remove();
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 2000);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="font-serif text-xl font-bold">Share Approval Link</DialogTitle>
          <DialogDescription className="text-muted-foreground mt-2">
            This link allows the customer to review and approve only the selected products. If you need to change selections later, you will need to prepare a new link.
          </DialogDescription>
        </DialogHeader>
        <div className="rounded-md border border-border bg-muted p-4 text-sm mt-2">
          <div className="flex gap-2 mb-2">
            <CheckCircle className="w-4 h-4 text-green-600 mt-0.5 shrink-0" />
            <div>
              <strong className="text-foreground block mb-0.5">Included in this link:</strong>
              <span className="text-foreground">{scope}</span>
            </div>
          </div>
          {approval?.notIncludedProductTypes.length ? (
            <div className="flex gap-2 mt-3 pt-3 border-t border-border">
              <span className="w-4 h-4 rounded-full border border-border bg-card mt-0.5 shrink-0"></span>
              <div>
                <strong className="text-muted-foreground block mb-0.5">Not included:</strong>
                <span className="text-muted-foreground">{approval.notIncludedProductTypes.map(categoryLabel).join(", ")}</span>
              </div>
            </div>
          ) : null}
        </div>
        <div className="space-y-2 mt-2">
          <Label htmlFor="scoped-share-link">Customer signing link</Label>
          <div className="flex gap-2">
            <Input id="scoped-share-link" readOnly value={url} onClick={(event) => event.currentTarget.select()} className=" text-sm bg-card" />
            <Button variant="outline" size="icon" onClick={copy} title="Copy scope-bound link" className="shrink-0 bg-card">
              {copied ? <Check className="h-4 w-4 text-green-700" /> : <Copy className="h-4 w-4 text-foreground" />}
            </Button>
          </div>
        </div>
        <div className="space-y-2 mt-4">
          <Label htmlFor="scoped-share-email">Customer email</Label>
          <div className="flex gap-2">
            <Input id="scoped-share-email" value={email} onChange={(event) => setEmail(event.target.value)} type="email" placeholder="customer@example.com" className="bg-card" />
            <Button asChild className="shrink-0">
              <a href={mailto}><Mail className="mr-2 h-4 w-4" />Open Email</a>
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export default function SignoffPage() {
  const { id } = useParams();
  const quoteId = Number(id);
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data: shareInfo } = useGetShareInfo({ query: { queryKey: getGetShareInfoQueryKey() } });
  const { data: detail, isLoading } = useGetQuote(quoteId, { query: { enabled: Number.isFinite(quoteId), queryKey: getGetQuoteQueryKey(quoteId) } });
  const { data: approvalResponse } = useListScopedApprovals(quoteId, {
    query: { enabled: Number.isFinite(quoteId), queryKey: getListScopedApprovalsQueryKey(quoteId) },
  });
  const [selected, setSelected] = useState<QuoteCategoriesItem[]>([]);
  const [prepared, setPrepared] = useState<ScopedApproval | null>(null);
  const [shareOpen, setShareOpen] = useState(false);
  const [isOpeningLegacyDocument, setIsOpeningLegacyDocument] = useState(false);
  const {
    openDocument: openScopedApprovalDocument,
    isOpening: isOpeningScopedApprovalDocument,
  } = useScopedApprovalDocument();
  const initializedQuoteRef = useRef<number | null>(null);

  const [legacyLink, setLegacyLink] = useState<ShareLink | null>(null);

  const createLegacyLink = useCreateShareLink({
    mutation: {
      onSuccess: (link) => {
        setLegacyLink(link);
      },
      onError: (err) => toast({ title: "Failed to get legacy link", description: err.message, variant: "destructive" })
    }
  });

  const revokeLegacyLink = useRevokeShareLink({
    mutation: {
      onSuccess: () => {
        toast({ title: "Legacy link revoked" });
        createLegacyLink.mutate({ id: quoteId }); // Refresh
      },
      onError: (err) => toast({ title: "Failed to revoke link", description: err.message, variant: "destructive" })
    }
  });

  const rotateLegacyLink = useRotateShareLink({
    mutation: {
      onSuccess: (link) => {
        setLegacyLink(link);
        toast({ title: "Legacy link rotated" });
      },
      onError: (err) => toast({ title: "Failed to rotate link", description: err.message, variant: "destructive" })
    }
  });

  const updateLegacyLink = useUpdateShareLink({
    mutation: {
      onSuccess: (link) => {
        setLegacyLink(link);
        toast({ title: "Expiry updated" });
      },
      onError: (err) => toast({ title: "Failed to update expiry", description: err.message, variant: "destructive" })
    }
  });

  const rotateScoped = useRotateScopedApprovalLink({
    mutation: {
      onSuccess: () => {
        toast({ title: "Scoped link rotated" });
        queryClient.invalidateQueries({ queryKey: getListScopedApprovalsQueryKey(quoteId) });
        queryClient.invalidateQueries({ queryKey: getGetQuoteQueryKey(quoteId) });
      },
      onError: (err) => toast({ title: "Failed to rotate link", description: err.message, variant: "destructive" })
    }
  });

  const updateScopedExpiry = useUpdateScopedApprovalLink({
    mutation: {
      onSuccess: () => {
        toast({ title: "Expiry updated" });
        queryClient.invalidateQueries({ queryKey: getListScopedApprovalsQueryKey(quoteId) });
        queryClient.invalidateQueries({ queryKey: getGetQuoteQueryKey(quoteId) });
      },
      onError: (err) => toast({ title: "Failed to update expiry", description: err.message, variant: "destructive" })
    }
  });

  useEffect(() => {
    if (detail && initializedQuoteRef.current !== quoteId) {
      initializedQuoteRef.current = quoteId;
      setSelected(detail.quote.categories);
    }
  }, [detail, quoteId]);

  const allRequests = approvalResponse?.approvals ?? [];
  const openRequests = allRequests.filter(approval => approval.status === "open" && scopedLinkAccessStatus(approval) === "active");

  useEffect(() => {
    if (!prepared || !approvalResponse) return;
    const currentRequest = approvalResponse.approvals.find(
      (approval) => approval.id === prepared.id,
    );
    if (!currentRequest || currentRequest.status !== "open" || scopedLinkAccessStatus(currentRequest) !== "active") {
      setPrepared(null);
      setShareOpen(false);
    }
  }, [approvalResponse, prepared]);

  const create = useCreateScopedApproval({
    mutation: {
      onSuccess: (approval) => {
        setPrepared(approval);
        queryClient.setQueryData<ScopedApprovalsResponse>(
          getListScopedApprovalsQueryKey(quoteId),
          (current) => current
            ? {
                ...current,
                approvals: [
                  approval,
                  ...current.approvals.filter((candidate) => candidate.token !== approval.token),
                ],
              }
            : current,
        );
        queryClient.invalidateQueries({ queryKey: getListScopedApprovalsQueryKey(quoteId) });
        queryClient.invalidateQueries({ queryKey: getGetQuoteQueryKey(quoteId) });
        toast({ title: "Scoped approval prepared", description: "The preview and customer link contain only the selected product types." });
      },
      onError: (error) => toast({ title: "Could not prepare approval", description: error.message, variant: "destructive" }),
    },
  });
  const cancel = useCancelScopedApproval({
    mutation: {
      onSuccess: (_result, variables) => {
        if (prepared?.id === variables.requestId) {
          setPrepared(null);
          setShareOpen(false);
        }
        queryClient.invalidateQueries({ queryKey: getListScopedApprovalsQueryKey(quoteId) });
        queryClient.invalidateQueries({ queryKey: getGetQuoteQueryKey(quoteId) });
        toast({
          title: "Customer link revoked",
          description: "Public access is blocked. Any signed evidence remains available to staff.",
        });
      },
      onError: (error) => toast({
        title: "Could not cancel approval request",
        description: error.message,
        variant: "destructive",
      }),
    },
  });
  const setRevisionExclusion = useSetRevisionSignoffExclusion({
    mutation: {
      onSuccess: (_revision, variables) => {
        setPrepared(null);
        queryClient.invalidateQueries({ queryKey: getGetQuoteQueryKey(quoteId) });
        queryClient.invalidateQueries({ queryKey: getListScopedApprovalsQueryKey(quoteId) });
        toast({
          title: variables.data.excludedFromSignoff ? "Revision excluded from customer documents" : "Revision included in customer documents",
          description: "The revision remains in the internal quote log. Any prepared scoped preview was cleared.",
        });
      },
      onError: (error) => toast({ title: "Could not update revision inclusion", description: error.message, variant: "destructive" }),
    },
  });

  if (isLoading) return <div className="p-8 flex items-center justify-center min-h-[100dvh] text-muted-foreground font-medium text-lg">Loading approval setup…</div>;
  if (!detail) return <div className="p-8 text-center text-destructive min-h-[100dvh] flex items-center justify-center">Quote not found.</div>;
  const categories = detail.quote.categories;
  const coverage = approvalResponse?.coverage ?? detail.approvalCoverage ?? [];
  const allSelected = selected.length === categories.length;
  
  const updateSelection = (next: QuoteCategoriesItem[]) => {
    setSelected(next);
    setPrepared(null);
  };
  
  const toggle = (type: QuoteCategoriesItem) => updateSelection(selected.includes(type) ? selected.filter((item) => item !== type) : [...selected, type]);
  const scopeLabel = selected.map(categoryLabel).join(", ");
  const hasOverlappingOpenRequest = openRequests.some((approval) =>
    approval.productTypes.some((type) => selected.includes(type)),
  );
  
  const reuseOpenRequest = (approval: ScopedApproval) => {
    setSelected([...approval.productTypes]);
    setPrepared(approval);
    setShareOpen(false);
    toast({
      title: "Existing request selected",
      description: "Reusing its original locked scope and customer link.",
    });
  };

  const openLegacyDocument = async () => {
    // Open synchronously so popup blockers allow the tab, then populate it
    // after the authenticated API client returns the immutable PDF.
    const documentWindow = window.open("", "_blank");
    if (!documentWindow) {
      toast({ title: "Could not open PDF", description: "Allow pop-ups for this site, then try again.", variant: "destructive" });
      return;
    }
    documentWindow.opener = null;
    setIsOpeningLegacyDocument(true);
    try {
      const pdf = await getSignedSignoffDocument(quoteId, { responseType: "blob" });
      const objectUrl = URL.createObjectURL(pdf);
      documentWindow.location.href = objectUrl;
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
    } catch (error) {
      documentWindow.close();
        toast({
          title: "Could not download original signed PDF",
        description: error instanceof Error ? error.message : "Please try again.",
        variant: "destructive",
      });
    } finally {
      setIsOpeningLegacyDocument(false);
    }
  };

  return (
    <div className="min-h-[100dvh] bg-muted">
      <div className="mx-auto max-w-4xl p-4 sm:p-8">
        <div className="mb-6 flex flex-col md:flex-row md:items-center justify-between gap-4 print:hidden">
          <div>
            <Button asChild variant="ghost" className="mb-2 -ml-2 text-muted-foreground hover:text-foreground">
              <Link href={`/quotes/${quoteId}`}>
                <ArrowLeft className="w-4 h-4 mr-1.5" /> Back to Quote #{detail.quote.quoteNumber}
              </Link>
            </Button>
            <h1 className="font-serif text-3xl font-extrabold text-foreground tracking-tight">Customer Approval Setup</h1>
            <p className="text-sm text-muted-foreground font-medium mt-1">Configure which product types and revisions the customer will see.</p>
          </div>
          {detail.legacyApproval?.documentAvailable ? (
            <Button type="button" variant="outline" className="bg-card text-foreground" onClick={openLegacyDocument} disabled={isOpeningLegacyDocument}>
              <Download className="mr-2 h-4 w-4" /> {isOpeningLegacyDocument ? "Opening PDF…" : "Download original signed PDF"}
            </Button>
          ) : detail.legacyApproval ? (
            <p className="text-right text-xs text-amber-700 max-w-xs font-medium">The legacy signature is recorded, but its original PDF is unavailable.</p>
          ) : null}
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-[1fr_320px] gap-8">
          
          <div className="space-y-6">
            <Card className="border-border shadow-sm overflow-hidden">
              <CardHeader className="bg-card border-b pb-4">
                <CardTitle className="text-lg flex items-center gap-2">
                  <PenTool className="w-5 h-5 text-foreground" />
                  Prepare customer approval link
                </CardTitle>
                <CardDescription className="text-muted-foreground">
                  Select the product types the customer is being asked to approve. You can preview the document before sharing the link.
                </CardDescription>
              </CardHeader>
              <CardContent className="p-6 bg-muted/50 space-y-6">
                <div className="flex items-center justify-between">
                  <div>
                    <h2 className="font-bold text-foreground text-sm">Product types to include</h2>
                  </div>
                  <Button variant="ghost" size="sm" className="h-8 text-muted-foreground" onClick={() => updateSelection(allSelected ? [] : [...categories])}>
                    {allSelected ? "Clear all" : "Select all"}
                  </Button>
                </div>
                
                <div className="grid gap-3 sm:grid-cols-2">
                  {categories.map((type) => {
                    const current = coverage.find((item) => item.productType === type);
                    const isSelected = selected.includes(type);
                    
                    let statusLabel = "Open";
                    let statusColor = "text-muted-foreground";
                    if (current?.status === "needs_resigning") { statusLabel = "Needs re-signing"; statusColor = "text-amber-600 font-semibold"; }
                    if (current?.status === "signed") { statusLabel = "Signed"; statusColor = "text-green-600 font-semibold"; }

                    return (
                      <label 
                        key={type} 
                        className={`flex cursor-pointer items-start gap-3 rounded-lg border-2 p-3 transition-colors ${
                          isSelected ? "border-primary bg-card shadow-sm" : "border-border bg-card/50 hover:bg-card"
                        }`}
                      >
                        <Checkbox 
                          checked={isSelected} 
                          className={isSelected ? "border-primary data-[state=checked]:bg-primary" : ""}
                          onCheckedChange={() => toggle(type)} 
                        />
                        <span className="flex-1">
                          <span className={`block font-bold text-sm ${isSelected ? "text-foreground" : "text-foreground"}`}>
                            {categoryLabel(type)}
                          </span>
                          <span className={`text-[11px] mt-0.5 block ${statusColor}`}>
                            Status: {statusLabel}
                          </span>
                        </span>
                      </label>
                    );
                  })}
                </div>

                {hasOverlappingOpenRequest && (
                  <div className="rounded-md border border-amber-300 bg-amber-50 p-4 flex gap-3 items-start">
                    <AlertTriangle className="w-5 h-5 text-amber-600 shrink-0 mt-0.5" />
                    <div className="text-sm text-amber-900">
                      <strong className="block mb-1">An approval link already exists for these products</strong>
                      Use the waiting approvals below to preview or resend the same request. The app prevents duplicate requests for these products.
                    </div>
                  </div>
                )}
                <Button 
                  className="w-full h-12 text-sm font-bold shadow-sm" 
                  disabled={!selected.length || create.isPending || hasOverlappingOpenRequest} 
                  onClick={() => create.mutate({ id: quoteId, data: { productTypes: [...selected] } })}
                >
                  {create.isPending ? "Preparing exact preview…" : `Prepare Preview for ${scopeLabel || "selected types"}`}
                </Button>
              </CardContent>
            </Card>

            {prepared && (
              <Card className="border-primary shadow-md ring-1 ring-ring/10">
                <CardHeader className="bg-primary text-primary-foreground">
                  <CardTitle className="text-lg flex items-center gap-2 text-white">
                    <CheckCircle className="w-5 h-5 text-white/80" />
                    Preview Ready
                  </CardTitle>
                </CardHeader>
                <CardContent className="p-6 space-y-6 bg-card">
                  <div className="rounded-lg border border-border bg-muted p-4 text-sm space-y-3">
                    <div className="flex gap-2">
                      <CheckCircle className="w-4 h-4 text-green-600 mt-0.5 shrink-0" />
                      <div>
                        <strong className="text-foreground block mb-0.5">Included in this link:</strong>
                        <span className="text-foreground font-medium">{prepared.productTypes.map(categoryLabel).join(", ")}</span>
                      </div>
                    </div>
                    {prepared.notIncludedProductTypes.length > 0 && (
                      <div className="flex gap-2 pt-3 border-t border-border">
                        <span className="w-4 h-4 rounded-full border border-border bg-card mt-0.5 shrink-0"></span>
                        <div>
                          <strong className="text-muted-foreground block mb-0.5">Not included:</strong>
                          <span className="text-muted-foreground">{prepared.notIncludedProductTypes.map(categoryLabel).join(", ")}</span>
                        </div>
                      </div>
                    )}
                  </div>
                  <div className="flex flex-col gap-3 sm:flex-row">
                    <Button asChild className="flex-1 h-11 bg-card text-foreground border-border hover:bg-muted" variant="outline">
                      <Link href={`/scoped-sign/${prepared.token}`}>
                        <ExternalLink className="mr-2 h-4 w-4" /> Open preview
                      </Link>
                    </Button>
                    <Button className="flex-1 h-11 bg-primary text-primary-foreground hover:bg-primary/90" onClick={() => setShareOpen(true)}>
                      <Share2 className="mr-2 h-4 w-4" /> Share new signoff
                    </Button>
                  </div>
                </CardContent>
              </Card>
            )}

            {openRequests.length > 0 && !prepared && (
              <Card>
                <CardHeader>
                  <CardTitle className="text-lg">Waiting for customer</CardTitle>
                  <CardDescription>No link maintenance needed. Review or resend an existing request.</CardDescription>
                </CardHeader>
                <CardContent className="space-y-3">
                  {openRequests.map(approval => (
                    <div key={approval.id} className="rounded-md border p-4 space-y-3">
                      <p className="font-medium">{approval.productTypes.map(categoryLabel).join(", ")}</p>
                      <Button variant="outline" onClick={() => reuseOpenRequest(approval)}>Review and share</Button>
                    </div>
                  ))}
                </CardContent>
              </Card>
            )}

            <p className="text-sm text-muted-foreground">
              Approvals are only complete after the customer reviews the document and submits a valid signature.
              Changes to approved content require a fresh approval; the original signed evidence is kept.
            </p>

            {allRequests.length > 0 && (
              <details className="rounded-lg border bg-card p-4">
                <summary className="cursor-pointer font-medium">Approval history and advanced controls</summary>
                <p className="my-3 text-sm text-muted-foreground">For exceptional cases only. You do not need to rotate or expire links as part of a normal sale.</p>
              <Card className="border-amber-200 shadow-sm overflow-hidden">
                <CardHeader className="bg-amber-50/50 border-b border-amber-100">
                  <CardTitle className="text-amber-900 text-lg">Approval Link History</CardTitle>
                  <CardDescription className="text-amber-800/70">
                    All scoped requests and their current statuses.
                  </CardDescription>
                </CardHeader>
                <CardContent className="p-4 space-y-4">
                  {allRequests.map((approval) => (
                    <div key={approval.id ?? approval.token} className="rounded-lg border border-amber-200 bg-card p-4 shadow-sm">
                      <div className="flex justify-between items-start mb-4">
                        <div>
                          <h4 className="font-bold text-foreground text-sm mb-1">Scope: {approval.productTypes.map(categoryLabel).join(", ")}</h4>
                          <p className="text-xs font-medium text-muted-foreground">Not included: {approval.notIncludedProductTypes.length ? approval.notIncludedProductTypes.map(categoryLabel).join(", ") : "None"}</p>
                        </div>
                        <div className="text-right">
                          <span className={`text-xs font-bold uppercase tracking-widest px-2 py-0.5 rounded-full ${approval.status === 'open' ? 'bg-amber-100 text-amber-800' : approval.status === 'signed' ? 'bg-green-100 text-green-800' : 'bg-gray-100 text-gray-800'}`}>
                            {approval.status === "signed" ? "Signed evidence" : approval.status}
                          </span>
                          <p className={`mt-1 text-[10px] font-bold uppercase tracking-wider ${scopedLinkAccessStatus(approval) === "active" ? "text-green-700" : "text-red-700"}`}>
                            Link access: {scopedLinkAccessStatus(approval)}
                          </p>
                          {approval.expiresAt && <p className="text-[10px] text-muted-foreground mt-1">Expires: {new Date(approval.expiresAt).toLocaleDateString()}</p>}
                        </div>
                      </div>
                      <div className="grid grid-cols-2 gap-2">
                        {(approval.status === "open" || approval.status === "signed") && scopedLinkAccessStatus(approval) === "active" ? (
                          <>
                            {approval.status === "open" && (
                              <>
                                <Button variant="outline" size="sm" className="bg-muted text-foreground" onClick={() => reuseOpenRequest(approval)}>
                                  Reuse this exact request
                                </Button>
                                <Button variant="outline" size="sm" className="bg-muted text-foreground" onClick={() => { setPrepared(approval); setShareOpen(true); }}>
                                  <Share2 className="mr-2 h-3.5 w-3.5" /> Share link
                                </Button>
                                <Button variant="outline" size="sm" className="bg-muted text-foreground col-span-2" onClick={() => {
                                  if (approval.id && window.confirm("Replace this customer link? The old link will stop working immediately.")) {
                                    rotateScoped.mutate({ id: quoteId, requestId: approval.id });
                                  }
                                }}>
                                  <RotateCcw className="mr-2 h-3.5 w-3.5" /> Replace customer link
                                </Button>
                              </>
                            )}
                            <Button variant="outline" size="sm" className="bg-muted text-foreground" onClick={() => {
                              if (approval.id) {
                                const expiresAt = new Date();
                                expiresAt.setDate(expiresAt.getDate() + 7);
                                updateScopedExpiry.mutate({ id: quoteId, requestId: approval.id, data: { expiresAt: expiresAt.toISOString() } });
                              }
                            }}>
                              <Clock className="mr-2 h-3.5 w-3.5" /> Set Expiry
                            </Button>
                            <Button variant="outline" size="sm" className="bg-muted text-foreground" onClick={() => {
                              if (approval.id) updateScopedExpiry.mutate({ id: quoteId, requestId: approval.id, data: { expiresAt: null } });
                            }}>
                              Remove expiry
                            </Button>
                            {approval.approvalId ? (
                              <Button
                                variant="outline"
                                size="sm"
                                className="bg-muted text-foreground"
                                disabled={isOpeningScopedApprovalDocument}
                                onClick={() => openScopedApprovalDocument(quoteId, approval.approvalId!)}
                              >
                                  <ExternalLink className="mr-2 h-3.5 w-3.5" /> Open signed evidence
                              </Button>
                            ) : (
                              <Button asChild variant="outline" size="sm" className="bg-muted text-foreground">
                                <Link href={`/scoped-sign/${approval.token}`}><ExternalLink className="mr-2 h-3.5 w-3.5" /> Open preview</Link>
                              </Button>
                            )}
                            <Button variant="outline" size="sm" className="text-amber-800 border-amber-300" onClick={() => {
                              if (approval.id && window.confirm("Expire this customer link now? Public access will stop immediately.")) {
                                updateScopedExpiry.mutate({ id: quoteId, requestId: approval.id, data: { expiresAt: new Date().toISOString() } });
                              }
                            }}>
                              Expire now
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              className="col-span-2 text-destructive hover:bg-destructive/10 hover:text-destructive"
                              disabled={approval.id === undefined || cancel.isPending}
                              onClick={() => {
                                if (approval.id === undefined) return;
                                if (window.confirm("Revoke this customer link? Public access will stop immediately, but signed evidence will be retained.")) {
                                  cancel.mutate({ id: quoteId, requestId: approval.id });
                                }
                              }}
                            >
                              Revoke customer link
                            </Button>
                          </>
                        ) : (
                          <>
                            {approval.approvalId ? (
                              <Button
                                variant="outline"
                                size="sm"
                                className="bg-muted text-foreground col-span-2"
                                disabled={isOpeningScopedApprovalDocument}
                                onClick={() => openScopedApprovalDocument(quoteId, approval.approvalId!)}
                              >
                                  <ExternalLink className="mr-2 h-3.5 w-3.5" /> Open retained signed evidence
                              </Button>
                            ) : (
                              <Button asChild variant="outline" size="sm" className="bg-muted text-foreground col-span-2">
                                <Link href={`/scoped-sign/${approval.token}`}><ExternalLink className="mr-2 h-3.5 w-3.5" /> View status</Link>
                              </Button>
                            )}
                            {!approval.approvalId && !approval.revokedAt && approval.expiresAt && new Date(approval.expiresAt).getTime() <= Date.now() && approval.id && (
                              <>
                                <Button variant="outline" size="sm" onClick={() => {
                                  if (window.confirm("Issue a replacement for this expired link? The expired link will remain inaccessible.")) {
                                    rotateScoped.mutate({ id: quoteId, requestId: approval.id! });
                                  }
                                }}>
                                  <RotateCcw className="mr-2 h-3.5 w-3.5" /> Issue replacement
                                </Button>
                                <Button variant="ghost" size="sm" className="text-destructive" onClick={() => {
                                  if (window.confirm("Revoke this expired link? Its lifecycle history will be retained.")) {
                                    cancel.mutate({ id: quoteId, requestId: approval.id! });
                                  }
                                }}>
                                  Revoke link
                                </Button>
                              </>
                            )}
                            {approval.approvalId && scopedLinkAccessStatus(approval) === "expired" && approval.id && (
                              <Button
                                variant="outline"
                                size="sm"
                                className="col-span-2"
                                onClick={() => updateScopedExpiry.mutate({ id: quoteId, requestId: approval.id!, data: { expiresAt: null } })}
                              >
                                Restore signed-link access
                              </Button>
                            )}
                            {approval.revocationReason && (
                              <p className="col-span-2 text-xs text-red-600 mt-1 font-medium">Revoked: {approval.revocationReason}</p>
                            )}
                            {approval.invalidationReason && (
                              <p className="col-span-2 text-xs text-amber-700 mt-1 font-medium">Invalidated: {approval.invalidationReason}</p>
                            )}
                          </>
                        )}
                      </div>
                    </div>
                  ))}
                </CardContent>
              </Card>
              </details>
            )}

            <details className="rounded-lg border bg-card p-4">
              <summary className="cursor-pointer text-sm font-medium">Older whole-quote links</summary>
              <p className="my-3 text-sm text-muted-foreground">Compatibility tools for previously shared links. Use the product approval workflow above for new requests.</p>
            <Card className="border-border shadow-sm overflow-hidden">
              <CardHeader className="bg-muted/50 border-b pb-4">
                <CardTitle className="font-serif text-lg font-bold text-foreground">Legacy Whole-Quote Approval Link</CardTitle>
                <CardDescription className="text-muted-foreground text-xs">
                  Manage the legacy link that exposes the entire quote.
                </CardDescription>
              </CardHeader>
              <CardContent className="p-4 space-y-4">
                {!legacyLink ? (
                  <Button variant="outline" className="w-full" onClick={() => createLegacyLink.mutate({ id: quoteId })} disabled={createLegacyLink.isPending}>
                    {createLegacyLink.isPending ? "Fetching..." : "Fetch / Generate Legacy Link"}
                  </Button>
                ) : (
                  <div className="space-y-4">
                    <div className="bg-muted rounded p-3 text-sm">
                      <p className="font-mono text-xs break-all">{shareInfo?.publicOrigin || window.location.origin}{import.meta.env.BASE_URL.replace(/\/$/, "")}/sign/{legacyLink.token}</p>
                      <p className="mt-2 text-xs font-bold uppercase tracking-widest text-muted-foreground">Status: <span className={legacyLink.status === 'active' ? 'text-green-600' : 'text-red-600'}>{legacyLink.status}</span></p>
                      {legacyLink.expiresAt && <p className="mt-1 text-xs text-muted-foreground">Expires: {new Date(legacyLink.expiresAt).toLocaleString()}</p>}
                    </div>
                    {legacyLink.status === 'active' && (
                      <div className="grid grid-cols-2 gap-2">
                        <Button asChild variant="outline" size="sm">
                          <Link href={`/sign/${legacyLink.token}`}><ExternalLink className="w-3.5 h-3.5 mr-2" /> Open</Link>
                        </Button>
                        <Button variant="outline" size="sm" onClick={() => {
                          navigator.clipboard.writeText(`${shareInfo?.publicOrigin || window.location.origin}${import.meta.env.BASE_URL.replace(/\/$/, "")}/sign/${legacyLink.token}`);
                          toast({ title: "Copied" });
                        }}>
                          <Copy className="w-3.5 h-3.5 mr-2" /> Copy
                        </Button>
                        <Button variant="outline" size="sm" onClick={() => {
                          if (window.confirm("Replace this legacy customer link? The old link will stop working immediately.")) {
                            rotateLegacyLink.mutate({ id: quoteId });
                          }
                        }}>
                          <RotateCcw className="w-3.5 h-3.5 mr-2" /> Rotate
                        </Button>
                        <Button variant="outline" size="sm" onClick={() => {
                          const date = new Date();
                          date.setDate(date.getDate() + 7);
                          updateLegacyLink.mutate({ id: quoteId, data: { expiresAt: date.toISOString() } });
                        }}>
                          <Clock className="w-3.5 h-3.5 mr-2" /> Expiry +7d
                        </Button>
                        <Button variant="ghost" size="sm" className="col-span-2 text-destructive hover:bg-destructive/10 hover:text-destructive" onClick={() => revokeLegacyLink.mutate({ id: quoteId })}>
                          <XCircle className="w-3.5 h-3.5 mr-2" /> Revoke
                        </Button>
                      </div>
                    )}
                    <div className="grid grid-cols-2 gap-2">
                      <Button variant="outline" size="sm" onClick={() => updateLegacyLink.mutate({ id: quoteId, data: { expiresAt: null } })} disabled={legacyLink.status === "revoked"}>
                        Remove expiry
                      </Button>
                      <Button variant="outline" size="sm" className="text-amber-800 border-amber-300" onClick={() => {
                        if (window.confirm("Expire this legacy customer link now? Public access will stop immediately.")) {
                          updateLegacyLink.mutate({ id: quoteId, data: { expiresAt: new Date().toISOString() } });
                        }
                      }} disabled={legacyLink.status === "revoked"}>
                        Expire now
                      </Button>
                      {legacyLink.status !== "active" && (
                        <Button variant="outline" size="sm" className="col-span-2" onClick={() => {
                          if (window.confirm("Issue a replacement legacy link? The old link will remain inaccessible.")) {
                            rotateLegacyLink.mutate({ id: quoteId });
                          }
                        }}>
                          <RotateCcw className="w-3.5 h-3.5 mr-2" /> Issue replacement link
                        </Button>
                      )}
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>
            </details>
          </div>

          <div className="space-y-6">
            <Card className="border-border shadow-sm bg-card overflow-hidden">
              <CardHeader className="bg-muted/50 border-b pb-4">
                <CardTitle className="font-serif text-lg font-bold text-foreground">Review revisions</CardTitle>
                <CardDescription className="text-muted-foreground text-xs">
                  Control which revisions appear in future customer documents. This never removes an entry from the internal revision log.
                </CardDescription>
              </CardHeader>
              <CardContent className="p-0">
                {detail.revisions.length === 0 ? (
                  <div className="p-6 text-center text-sm font-medium text-muted-foreground">
                    No revisions have been recorded for this quote.
                  </div>
                ) : (
                  <div className="max-h-[32rem] divide-y divide-slate-100 overflow-y-auto overscroll-contain">
                    {detail.revisions.map((revision) => (
                      <div key={revision.id} className="p-4 hover:bg-muted transition-colors">
                        <div className="flex justify-between items-start gap-4 mb-2">
                          <div className="min-w-0">
                            <span className="text-xs font-bold text-foreground block">{revision.authorName}</span>
                            <span className="text-[10px] uppercase font-bold text-muted-foreground block tracking-wider mt-0.5">
                              {revision.excludedFromSignoff ? "Excluded from customer documents" : "Included in customer documents"}
                            </span>
                          </div>
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            className={`h-7 px-2 text-xs font-bold ${revision.excludedFromSignoff ? "bg-card text-muted-foreground" : "bg-primary text-primary-foreground hover:bg-primary/90 hover:text-primary-foreground border-primary"}`}
                            disabled={setRevisionExclusion.isPending}
                            onClick={() => setRevisionExclusion.mutate({
                              id: quoteId,
                              revisionId: revision.id,
                              data: { excludedFromSignoff: !revision.excludedFromSignoff },
                            })}
                          >
                            {revision.excludedFromSignoff ? "Include" : "Exclude"}
                          </Button>
                        </div>
                        <p className="text-xs text-muted-foreground leading-relaxed bg-card border rounded p-2 shadow-sm">
                          {revision.note}
                        </p>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          </div>

        </div>
        <ScopedShareDialog approval={prepared} quoteNumber={detail.quote.quoteNumber} customerName={detail.quote.customerName} open={shareOpen} onOpenChange={setShareOpen} />
      </div>
    </div>
  );
}