import { useEffect, useRef, useState } from "react";
import { useLocation, useParams, Link } from "wouter";
import { format } from "date-fns";
import { useQueryClient } from "@tanstack/react-query";
import { useForm, Controller } from "react-hook-form";
import { z } from "zod";
import { zodResolver } from "@hookform/resolvers/zod";
import { Printer, PenTool, CheckCircle, AlertCircle, MessageSquare, ArrowLeft, Edit, Paperclip, Upload, Download, Trash2, FileImage, FileText, FileEdit, Archive, ArchiveRestore, Clock, ChevronRight } from "lucide-react";
import { 
  useGetQuote, 
  getGetQuoteQueryKey,
  getGetRecentActivityQueryKey, 
  useUpdateQuote,
  getListQuotesQueryKey,
  useListAttachments,
  getListAttachmentsQueryKey,
  useCreateAttachment,
  useDeleteAttachment,
  getListRevisionsQueryKey,
  useArchiveQuote,
  useUnarchiveQuote,
  useGetRevisionDraft,
  getGetRevisionDraftQueryKey,
  useSaveRevisionDraft,
  useDiscardRevisionDraft,
  usePublishRevisionDraft,
  useListScopedApprovals,
  getListScopedApprovalsQueryKey,
  type ScopedApproval
} from "@workspace/api-client-react";
import { useUpload } from "@workspace/object-storage-web";
import { Shell } from "@/components/layout";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { useToast } from "@/components/ui/toaster";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "@/components/ui/dialog";
import type { RevisionCategoriesItem } from "@workspace/api-client-react";
import { categoryLabel } from "@/lib/revision-categories";
import { CopyButton } from "@/components/copy-button";
import { formatRevisionsDigest } from "@/lib/copy-text";
import { INTERIOR_DOOR_FIELDS, EXTERIOR_DOOR_FIELDS, LEGACY_DOOR_FIELDS, REMOVED_INTERIOR_DOOR_FIELDS } from "@/lib/spec-fields";
import { SpecInput, useFieldOptions } from "@/components/spec-input";
import { AddressAutocomplete } from "@/components/address-autocomplete";
import { categoryLabel as productTypeLabel } from "@/lib/revision-categories";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";

const sameTags = (a: string[], b: string[]) =>
  a.length === b.length && a.every((t) => b.includes(t));

const doorSpecSchema = z.object({
  brand: z.string().optional(),
  seriesStyle: z.string().optional(),
  materialSpecies: z.string().optional(),
  exteriorColor: z.string().optional(),
  interiorFinish: z.string().optional(),
  jambDepth: z.string().optional(),
  hardwareFinish: z.string().optional(),
  glassLiteOptions: z.string().optional(),
  lockPrep: z.string().optional(),
}).optional();

const quoteSchema = z.object({
  quoteNumber: z.string().regex(/^[0-9]{7}$/, "Must be exactly 7 digits"),
  customerName: z.string().min(1, "Customer name is required"),
  projectName: z.string().min(1, "Project name is required"),
  jobAddress: z.string().min(1, "Job address is required"),
  categories: z.array(z.enum(["doors", "interiorDoors", "exteriorDoors", "windows", "trim", "millwork"])).min(1, "Select at least one category"),
  notes: z.string().optional(),
  specs: z.object({
    window: z.object({
      brand: z.string().optional(),
      series: z.string().optional(),
      exteriorColor: z.string().optional(),
      interiorColor: z.string().optional(),
      jambDepth: z.string().optional(),
      dividedLites: z.string().optional(),
      hardwareFinish: z.string().optional(),
      screenColor: z.string().optional(),
    }).optional(),
    door: doorSpecSchema,
    interiorDoor: doorSpecSchema,
    exteriorDoor: doorSpecSchema,
    trimDescription: z.string().optional(),
    millworkDescription: z.string().optional(),
  }).optional(),
});

type QuoteFormValues = z.infer<typeof quoteSchema>;

function formatFileSize(bytes: number | null | undefined) {
  if (!bytes) return null;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function AttachmentsCard({ quoteId, readOnly = false }: { quoteId: number; readOnly?: boolean }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const { data: attachments = [], isLoading } = useListAttachments(quoteId, {
    query: { enabled: !!quoteId, queryKey: getListAttachmentsQueryKey(quoteId) },
  });
  const createAttachment = useCreateAttachment();
  const deleteAttachment = useDeleteAttachment();

  const { uploadFile, isUploading, progress } = useUpload({
    onError: (err) => {
      toast({ title: "Upload failed", description: err.message, variant: "destructive" });
    },
  });

  const handleFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    for (const file of Array.from(files)) {
      const result = await uploadFile(file);
      if (!result) continue;
      createAttachment.mutate(
        {
          id: quoteId,
          data: {
            name: file.name,
            objectPath: result.objectPath,
            contentType: file.type || null,
            size: file.size,
          },
        },
        {
          onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: getListAttachmentsQueryKey(quoteId) });
            toast({ title: "File attached", description: `${file.name} was added to this quote.` });
          },
          onError: () => {
            toast({ title: "Error", description: `Failed to save ${file.name}.`, variant: "destructive" });
          },
        },
      );
    }
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const handleDelete = (attachmentId: number, name: string) => {
    deleteAttachment.mutate(
      { id: quoteId, attachmentId },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListAttachmentsQueryKey(quoteId) });
          toast({ title: "Attachment removed", description: `${name} was removed.` });
        },
        onError: () => {
          toast({ title: "Error", description: "Failed to remove attachment.", variant: "destructive" });
        },
      },
    );
  };

  return (
    <Card className="border-border">
      <CardHeader className="pb-3 border-b">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <CardTitle className="flex items-center gap-2 text-base font-bold uppercase tracking-wider text-foreground">
            <Paperclip className="w-4 h-4" />
            Attachments
          </CardTitle>
          {!readOnly && (
            <Button
              variant="outline"
              size="sm"
              className="w-full sm:w-auto h-8 bg-card"
              disabled={isUploading}
              onClick={() => fileInputRef.current?.click()}
            >
              <Upload className="w-3.5 h-3.5 mr-1.5" />
              {isUploading ? `Uploading... ${progress}%` : "Add File"}
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent className="pt-4 space-y-4">
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="hidden"
          accept="image/*,.pdf,.dwg,.dxf,.doc,.docx,.xls,.xlsx"
          onChange={(e) => handleFiles(e.target.files)}
        />
        {isLoading ? (
          <p className="text-center text-sm text-muted-foreground font-medium py-2">Loading attachments...</p>
        ) : attachments.length === 0 ? (
          <p className="text-center text-sm text-muted-foreground py-4 bg-muted rounded border border-dashed">
            No files attached yet.
          </p>
        ) : (
          <ul className="space-y-2">
            {attachments.map((att) => {
              const isImage = att.contentType?.startsWith("image/");
              const sizeLabel = formatFileSize(att.size);
              return (
                <li
                  key={att.id}
                  className="flex items-center gap-3 p-2.5 border border-border rounded-lg bg-card shadow-sm"
                >
                  {isImage ? (
                    <FileImage className="w-5 h-5 text-muted-foreground shrink-0" />
                  ) : (
                    <FileText className="w-5 h-5 text-muted-foreground shrink-0" />
                  )}
                  <div className="flex-1 min-w-0">
                    <p className="font-bold text-sm text-foreground truncate" title={att.name}>{att.name}</p>
                    <p className="text-xs text-muted-foreground font-medium">
                      {att.uploadedByName} · {format(new Date(att.createdAt), "MMM d")}
                      {sizeLabel ? ` · ${sizeLabel}` : ""}
                    </p>
                  </div>
                  <div className="flex items-center shrink-0">
                    <Button asChild variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground" title="Download">
                      <a href={`/api/storage${att.objectPath}`} download={att.name} target="_blank" rel="noreferrer">
                        <Download className="w-3.5 h-3.5" />
                      </a>
                    </Button>
                    {!readOnly && (
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 text-muted-foreground hover:text-destructive hover:bg-destructive/10"
                        title="Remove"
                        disabled={deleteAttachment.isPending}
                        onClick={() => handleDelete(att.id, att.name)}
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </Button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

const CATEGORIES = [
  { id: "interiorDoors", label: "Interior Doors" },
  { id: "exteriorDoors", label: "Exterior Doors" },
  { id: "windows", label: "Windows" },
  { id: "trim", label: "Moulding" },
  { id: "millwork", label: "Misc. Millwork" },
] as const;

export default function QuoteDetailPage() {
  const { id } = useParams();
  const quoteId = parseInt(id || "0", 10);
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data: detail, isLoading } = useGetQuote(quoteId, { 
    query: { enabled: !!quoteId, queryKey: getGetQuoteQueryKey(quoteId) } 
  });
  const { data: scopedApprovalData } = useListScopedApprovals(quoteId, {
    query: { enabled: !!quoteId, queryKey: getListScopedApprovalsQueryKey(quoteId) },
  });
  const updateQuote = useUpdateQuote();
  const { optionsFor } = useFieldOptions();
  const archiveQuote = useArchiveQuote();
  const unarchiveQuote = useUnarchiveQuote();
  const saveDraft = useSaveRevisionDraft();
  const discardDraft = useDiscardRevisionDraft();
  const publishDraft = usePublishRevisionDraft();

  const { data: draftLookup } = useGetRevisionDraft(quoteId, {
    query: { enabled: !!quoteId, queryKey: getGetRevisionDraftQueryKey(quoteId) },
  });
  const draft = draftLookup?.draft ?? null;

  const [note, setNote] = useState("");
  // Category tags selected for the update being composed.
  const [tags, setTags] = useState<RevisionCategoriesItem[]>([]);
  // The note the server currently holds as this user's draft ("" = none).
  const [savedDraftNote, setSavedDraftNote] = useState<string | null>(null);
  const [savedDraftTags, setSavedDraftTags] = useState<RevisionCategoriesItem[] | null>(null);
  const hydratedDraftRef = useRef(false);
  const [pendingNavHref, setPendingNavHref] = useState<string | null>(null);

  // Latest composer state, readable from unmount cleanups without stale closures.
  const composerRef = useRef({ note: "", savedDraftNote: null as string | null, tags: [] as RevisionCategoriesItem[] });
  composerRef.current = { note, savedDraftNote, tags };
  const saveDraftMutateAsyncRef = useRef(saveDraft.mutateAsync);
  saveDraftMutateAsyncRef.current = saveDraft.mutateAsync;

  // Per-quote lifecycle: reset all composer/draft state when the quote id
  // changes (the page component can be reused across quote routes), and
  // flush any unsaved typing as a draft when leaving this quote — this
  // covers browser back/forward and programmatic navigation, which cannot
  // be intercepted for a confirmation dialog (wouter navigation is not
  // cancelable), so instead of losing text we quietly save it.
  useEffect(() => {
    hydratedDraftRef.current = false;
    setNote("");
    setTags([]);
    setSavedDraftNote(null);
    setSavedDraftTags(null);
    setPendingNavHref(null);
    setRevisionPage(1);
    const flushQuoteId = quoteId;
    return () => {
      const { note: text, savedDraftNote: saved, tags: flushTags } = composerRef.current;
      if (flushQuoteId && text.trim() && text !== (saved ?? "")) {
        // Route the flush through the write queue so it stays ordered
        // behind any in-flight draft writes for this quote.
        enqueueDraftWriteRef
          .current(() => saveDraftMutateAsyncRef.current({ id: flushQuoteId, data: { note: text, categories: flushTags } }))
          .then(() => {
            queryClient.invalidateQueries({ queryKey: getGetRevisionDraftQueryKey(flushQuoteId) });
          })
          .catch(() => undefined);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [quoteId]);

  // Hydrate the composer from the saved draft once, on first load.
  useEffect(() => {
    if (draftLookup === undefined || hydratedDraftRef.current) return;
    hydratedDraftRef.current = true;
    setSavedDraftNote(draft?.note ?? null);
    setSavedDraftTags(draft ? (draft.categories ?? []) : null);
    if (draft && draft.note) {
      setNote((current) => (current.trim() ? current : draft.note));
      setTags((current) => (current.length ? current : (draft.categories ?? [])));
    }
  }, [draftLookup, draft]);

  const hasDraft = savedDraftNote !== null;
  const isDirty =
    note.trim() !== "" &&
    (note !== (savedDraftNote ?? "") || !sameTags(tags, savedDraftTags ?? []));

  // Draft-write coordination
  const writeEpochRef = useRef(0);
  const writeChainRef = useRef<Promise<unknown>>(Promise.resolve());

  const enqueueDraftWrite = <T,>(fn: () => Promise<T>): Promise<T> => {
    const run = writeChainRef.current.then(fn);
    writeChainRef.current = run.catch(() => undefined);
    return run;
  };
  const enqueueDraftWriteRef = useRef(enqueueDraftWrite);
  enqueueDraftWriteRef.current = enqueueDraftWrite;

  const persistDraft = (text: string, opts?: { silent?: boolean; onSuccess?: () => void }) => {
    const epoch = writeEpochRef.current;
    const draftTags = composerRef.current.tags;
    enqueueDraftWrite(async () => {
      if (epoch !== writeEpochRef.current) return null;
      return saveDraft.mutateAsync({ id: quoteId, data: { note: text, categories: draftTags } });
    })
      .then((saved) => {
        if (!saved || epoch !== writeEpochRef.current) return;
        setSavedDraftNote(saved.note);
        setSavedDraftTags(saved.categories ?? []);
        queryClient.invalidateQueries({ queryKey: getGetRevisionDraftQueryKey(quoteId) });
        if (!opts?.silent) {
          toast({ title: "Draft saved", description: "Your update is saved privately — it isn't published yet." });
        }
        opts?.onSuccess?.();
      })
      .catch(() => {
        if (!opts?.silent && epoch === writeEpochRef.current) {
          toast({ title: "Error", description: "Failed to save draft.", variant: "destructive" });
        }
      });
  };

  // Auto-save
  useEffect(() => {
    if (!isDirty || !hydratedDraftRef.current) return;
    if (publishDraft.isPending) return;
    const epoch = writeEpochRef.current;
    const timer = setTimeout(() => {
      if (epoch !== writeEpochRef.current) return;
      if (publishDraft.isPending) return;
      persistDraft(note, { silent: true });
    }, 2500);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [note, tags, isDirty, publishDraft.isPending]);

  // Warn before leaving the page
  useEffect(() => {
    if (!isDirty) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [isDirty]);

  // Guard in-app navigation
  useEffect(() => {
    if (!isDirty) return;
    const handler = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0) return;
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const anchor = (e.target as HTMLElement | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!anchor) return;
      if (anchor.target && anchor.target !== "_self") return;
      if (anchor.hasAttribute("download")) return;
      const url = new URL(anchor.href, window.location.href);
      if (url.origin !== window.location.origin) return;
      const dest = url.pathname + url.search + url.hash;
      if (dest === window.location.pathname + window.location.search + window.location.hash) return;
      e.preventDefault();
      e.stopPropagation();
      setPendingNavHref(dest);
    };
    document.addEventListener("click", handler, true);
    return () => document.removeEventListener("click", handler, true);
  }, [isDirty]);
  const [isEditing, setIsEditing] = useState(false);
  const [isCoordinatingPublish, setIsCoordinatingPublish] = useState(false);
  const [pendingData, setPendingData] = useState<QuoteFormValues | null>(null);
  const [isArchiveDialogOpen, setIsArchiveDialogOpen] = useState(false);
  const [isRevisionWarningOpen, setIsRevisionWarningOpen] = useState(false);
  const [archiveReason, setArchiveReason] = useState("");
  const [revisionPage, setRevisionPage] = useState(1);
  const REVISIONS_PER_PAGE = 5;

  const revisionCount = detail?.revisions?.length || 0;
  useEffect(() => {
    const totalPages = Math.ceil(revisionCount / REVISIONS_PER_PAGE);
    if (totalPages > 0 && revisionPage > totalPages) {
      setRevisionPage(totalPages);
    } else if (totalPages === 0 && revisionPage !== 1) {
      setRevisionPage(1);
    }
  }, [revisionCount, revisionPage]);

  const form = useForm<QuoteFormValues>({
    resolver: zodResolver(quoteSchema),
    defaultValues: {
      quoteNumber: "",
      customerName: "",
      projectName: "",
      jobAddress: "",
      categories: [],
      notes: "",
      specs: {},
    },
  });

  if (isLoading) {
    return (
      <Shell>
        <div className="flex items-center justify-center h-64 text-muted-foreground font-medium text-lg">
          Loading quote details...
        </div>
      </Shell>
    );
  }

  if (!detail) {
    return (
      <Shell>
        <div className="text-center py-12">
          <h2 className="text-2xl font-bold text-destructive mb-2">Quote Not Found</h2>
          <Button asChild variant="outline" className="mt-4"><Link href="/quotes">Back to Dashboard</Link></Button>
        </div>
      </Shell>
    );
  }

  const { quote, revisions, legacyApproval } = detail;
  const coverage = scopedApprovalData?.coverage ?? detail.approvalCoverage ?? [];
  const activeTypes = quote.categories;
  const fullyApproved = quote.approvalStatus === "signed";
  const partiallyApproved = quote.approvalStatus === "partial";
  const needsResigning = quote.approvalStatus === "needs_resigning";
  const legacyNeedsResigning = legacyApproval?.validity === "needs_resigning";
  const hasCurrentApproval = quote.signed || fullyApproved || partiallyApproved;
  const signedSnapshots = (scopedApprovalData?.approvals ?? []).filter(
    (approval): approval is ScopedApproval & { approvalId: number } =>
      approval.status === "signed" && approval.approvalId !== null && approval.approvalId !== undefined,
  );
  const selectedCategories = form.watch("categories") || [];

  const handleAddUpdate = (e: React.FormEvent) => {
    e.preventDefault();
    if (!note.trim()) return;
    if (hasCurrentApproval) {
      setIsRevisionWarningOpen(true);
      return;
    }
    executeAddUpdate();
  };

  const finishPublish = () => {
    setNote("");
    setTags([]);
    setSavedDraftNote(null);
    setSavedDraftTags(null);
    setIsRevisionWarningOpen(false);
    setRevisionPage(1);
    toast({ title: "Update added", description: "The revision log has been updated." });
    queryClient.invalidateQueries({ queryKey: getGetQuoteQueryKey(quoteId) });
    queryClient.invalidateQueries({ queryKey: getListQuotesQueryKey() });
    queryClient.invalidateQueries({ queryKey: getGetRevisionDraftQueryKey(quoteId) });
  };

  const publishError = () => {
    toast({ title: "Error", description: "Failed to add update.", variant: "destructive" });
  };

  const executeAddUpdate = () => {
    setIsCoordinatingPublish(true);
    writeEpochRef.current++;
    enqueueDraftWrite(() => publishDraft.mutateAsync({ id: quoteId, data: { note, categories: tags } }))
      .then(finishPublish)
      .catch(publishError)
      .finally(() => setIsCoordinatingPublish(false));
  };

  const isPublishing = publishDraft.isPending || isCoordinatingPublish;

  const handleSaveDraft = () => {
    if (!note.trim()) return;
    persistDraft(note);
  };

  const handleDiscardDraft = () => {
    writeEpochRef.current++;
    enqueueDraftWrite(() => discardDraft.mutateAsync({ id: quoteId }))
      .then(() => {
        setNote("");
        setTags([]);
        setSavedDraftNote(null);
        setSavedDraftTags(null);
        queryClient.invalidateQueries({ queryKey: getGetRevisionDraftQueryKey(quoteId) });
        toast({ title: "Draft discarded", description: "The draft was removed. Nothing was published." });
      })
      .catch(() => {
        toast({ title: "Error", description: "Failed to discard draft.", variant: "destructive" });
      });
  };

  const startEditing = () => {
    form.reset({
      quoteNumber: quote.quoteNumber,
      customerName: quote.customerName,
      projectName: quote.projectName,
      jobAddress: quote.jobAddress,
      categories: quote.categories as any,
      notes: quote.notes || "",
      specs: quote.specs ? {
        window: quote.specs.window || {},
        door: quote.specs.door || {},
        interiorDoor: quote.specs.interiorDoor || {},
        exteriorDoor: quote.specs.exteriorDoor || {},
        trimDescription: quote.specs.trimDescription || "",
        millworkDescription: quote.specs.millworkDescription || "",
      } as any : {},
    });
    setIsEditing(true);
  };

  const cancelEditing = () => {
    setIsEditing(false);
    setPendingData(null);
  };

  const onSubmit = (data: QuoteFormValues) => {
    if (hasCurrentApproval) {
      setPendingData(data);
    } else {
      executeSave(data);
    }
  };

  const executeSave = (data: QuoteFormValues) => {
    updateQuote.mutate({ id: quoteId, data }, {
      onSuccess: () => {
        toast({ title: "Quote Updated", description: "Changes saved successfully." });
        queryClient.invalidateQueries({ queryKey: getGetQuoteQueryKey(quoteId) });
        queryClient.invalidateQueries({ queryKey: getListQuotesQueryKey() });
        queryClient.invalidateQueries({ queryKey: getListRevisionsQueryKey(quoteId) });
        setIsEditing(false);
        setPendingData(null);
      },
      onError: () => {
        toast({ title: "Error", description: "Failed to update quote.", variant: "destructive" });
      }
    });
  };

  const refreshQuote = () => {
    queryClient.invalidateQueries({ queryKey: getGetQuoteQueryKey(quoteId) });
    queryClient.invalidateQueries({ queryKey: getListQuotesQueryKey() });
    queryClient.invalidateQueries({ queryKey: getListRevisionsQueryKey(quoteId) });
    queryClient.invalidateQueries({ queryKey: getGetRecentActivityQueryKey() });
  };

  const handleArchive = () => {
    if (!archiveReason.trim()) return;
    archiveQuote.mutate({ id: quoteId, data: { reason: archiveReason.trim() } }, {
      onSuccess: () => {
        refreshQuote();
        setIsArchiveDialogOpen(false);
        setArchiveReason("");
        toast({ title: "Quote archived", description: "The quote is kept with its full history and can be restored anytime." });
      },
      onError: (err: any) => {
        toast({ title: "Error", description: err?.data?.error || "Failed to archive quote.", variant: "destructive" });
      }
    });
  };

  const handleUnarchive = () => {
    unarchiveQuote.mutate({ id: quoteId }, {
      onSuccess: () => {
        refreshQuote();
        toast({ title: "Quote restored", description: "The quote is active again." });
      },
      onError: (err: any) => {
        toast({ title: "Error", description: err?.data?.error || "Failed to restore quote.", variant: "destructive" });
      }
    });
  };

  const renderSpecGrid = (specs: Record<string, any> | undefined | null) => {
    if (!specs) return null;
    const entries = Object.entries(specs).filter(([_, v]) => v);
    if (entries.length === 0) return <p className="text-muted-foreground italic text-sm">No details provided.</p>;
    
    return (
      <div className="grid grid-cols-1 gap-y-2 pb-2">
        {entries.map(([k, v]) => (
          <div key={k} className="flex justify-between items-end border-b border-border/50 pb-1">
            <span className="text-xs text-muted-foreground font-bold uppercase tracking-wider">
              {k.replace(/([A-Z])/g, ' $1').trim()}
            </span>
            <span className="text-foreground text-sm font-medium text-right max-w-[60%] leading-tight">{v}</span>
          </div>
        ))}
      </div>
    );
  };

  return (
    <Shell>
      <div className="mb-6">
        <Link href="/quotes" className="inline-flex items-center text-sm font-bold text-muted-foreground hover:text-primary transition-colors mb-4">
          <ArrowLeft className="w-4 h-4 mr-1" /> Back to Dashboard
        </Link>
        <div className="flex flex-col md:flex-row md:items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-3 mb-1">
              <h1 className="text-3xl font-serif font-extrabold tracking-tight text-foreground">{quote.quoteNumber}</h1>
              {quote.archived ? (
                <Badge variant="outline" className="text-xs px-2.5 py-0.5 text-muted-foreground">Archived</Badge>
              ) : needsResigning || legacyNeedsResigning ? (
                <Badge variant="outline" className="border-amber-400 bg-amber-50 text-amber-950 text-xs px-2.5 py-0.5">Needs Re-signing</Badge>
              ) : fullyApproved ? (
                <Badge variant="success" className="text-xs px-2.5 py-0.5 bg-green-100 text-green-800 border-green-200">Signed</Badge>
              ) : partiallyApproved ? (
                <Badge variant="outline" className="border-primary/30 bg-primary/5 text-primary text-xs px-2.5 py-0.5">Partially Approved</Badge>
              ) : quote.signed ? (
                <Badge variant="success" className="text-xs px-2.5 py-0.5 bg-green-100 text-green-800 border-green-200">Signed</Badge>
              ) : legacyApproval ? (
                <Badge variant="outline" className="text-xs px-2.5 py-0.5 text-muted-foreground bg-muted">Legacy signature record</Badge>
              ) : (
                <Badge variant="warning" className="text-xs px-2.5 py-0.5 bg-amber-100 text-amber-800 border-amber-200">Awaiting Signoff</Badge>
              )}
            </div>
            <p className="text-lg font-semibold text-foreground">{quote.displayName}</p>
            <p className="text-sm text-muted-foreground">{quote.jobAddress}</p>
          </div>
          
          <div className="flex flex-wrap items-center gap-2">
            {!quote.archived && !isEditing && (
              <Button variant="outline" className="bg-card hover:bg-muted" onClick={startEditing}>
                <Edit className="w-4 h-4 mr-2 text-muted-foreground" /> Edit Quote
              </Button>
            )}
            <Button asChild variant="outline" className="bg-card hover:bg-muted" disabled={isEditing}>
              <Link href={`/quotes/${quote.id}/print-log`}>
                <Printer className="w-4 h-4 mr-2 text-muted-foreground" /> Print Log
              </Link>
            </Button>
            <Button asChild variant="secondary" className="bg-muted text-foreground hover:bg-muted/80" disabled={isEditing}>
              <Link href={`/quotes/${quote.id}/packets`}>
                <FileImage className="w-4 h-4 mr-2 text-muted-foreground" /> Manufacturer Quote(s)
              </Link>
            </Button>
            {quote.archived && !quote.signed && !partiallyApproved ? (
              <Button disabled title="Archived quotes can't be signed. Restore the quote first.">
                <PenTool className="w-4 h-4 mr-2" /> Prepare Approval
              </Button>
            ) : (
              <Button asChild className={fullyApproved || partiallyApproved ? "bg-green-700 hover:bg-green-800 text-primary-foreground" : needsResigning || legacyNeedsResigning ? "bg-amber-600 hover:bg-amber-700 text-primary-foreground" : "bg-primary text-primary-foreground"} disabled={isEditing}>
                <Link href={`/quotes/${quote.id}/signoff`}>
                  <PenTool className="w-4 h-4 mr-2" />
                  {quote.signed || partiallyApproved || fullyApproved || needsResigning ? "Manage Approvals" : "Prepare Approval"}
                </Link>
              </Button>
            )}
          </div>
        </div>
      </div>

      {isEditing ? (
        <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-8 animate-in fade-in slide-in-from-bottom-2 duration-300">
           <Card className="border-border shadow-sm">
             <CardHeader className="flex flex-row items-center justify-between pb-4 border-b bg-muted/50">
               <CardTitle>Edit Quote Information</CardTitle>
             </CardHeader>
             <CardContent className="space-y-6 pt-6">
               <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6">
                 <div className="space-y-2 lg:col-span-1">
                   <Label htmlFor="quoteNumber">BisTrack Quote #</Label>
                   <Input 
                     id="quoteNumber" 
                     placeholder="e.g. 1234567" 
                     inputMode="numeric"
                     maxLength={7}
                     {...form.register("quoteNumber")} 
                   />
                   {form.formState.errors.quoteNumber && (
                     <p className="text-xs text-destructive font-medium">{form.formState.errors.quoteNumber.message}</p>
                   )}
                 </div>
                 <div className="space-y-2 lg:col-span-1">
                   <Label htmlFor="customerName">Customer Name</Label>
                   <Input 
                     id="customerName" 
                     placeholder="e.g. John Doe" 
                     {...form.register("customerName")} 
                   />
                   {form.formState.errors.customerName && (
                     <p className="text-xs text-destructive font-medium">{form.formState.errors.customerName.message}</p>
                   )}
                 </div>
                 <div className="space-y-2 lg:col-span-1">
                   <Label htmlFor="projectName">Project Name</Label>
                   <Input 
                     id="projectName" 
                     placeholder="e.g. Main Street Renovation" 
                     {...form.register("projectName")} 
                   />
                   {form.formState.errors.projectName && (
                     <p className="text-xs text-destructive font-medium">{form.formState.errors.projectName.message}</p>
                   )}
                 </div>
                 <div className="space-y-2 lg:col-span-1">
                   <Label htmlFor="jobAddress">Job Address</Label>
                   <Controller
                     name="jobAddress"
                     control={form.control}
                     render={({ field }) => (
                       <AddressAutocomplete
                         id="jobAddress"
                         value={field.value}
                         onChange={field.onChange}
                         onBlur={field.onBlur}
                       />
                     )}
                   />
                   {form.formState.errors.jobAddress && (
                     <p className="text-xs text-destructive font-medium">{form.formState.errors.jobAddress.message}</p>
                   )}
                 </div>
               </div>

               <div className="space-y-3 pt-6 border-t border-border">
                 <Label className="text-base">Product Categories</Label>
                 <div className="flex flex-wrap gap-3">
                   {(quote.categories.includes("doors")
                     ? [{ id: "doors", label: "Doors (Legacy)" } as const, ...CATEGORIES]
                     : [...CATEGORIES]
                   ).map(category => (
                     <Controller
                       key={category.id}
                       name="categories"
                       control={form.control}
                       render={({ field }) => (
                         <label 
                           className={`flex items-center gap-2.5 px-4 py-2 border rounded-full cursor-pointer transition-colors ${
                             field.value?.includes(category.id) ? 'border-primary bg-primary text-primary-foreground' : 'border-border bg-card hover:bg-muted text-foreground'
                           }`}
                         >
                           <Checkbox 
                             checked={field.value?.includes(category.id)}
                             className={field.value?.includes(category.id) ? "border-white/50 data-[state=checked]:bg-card data-[state=checked]:text-foreground" : ""}
                             onCheckedChange={(checked) => {
                               const current = field.value || [];
                               const next = checked 
                                 ? [...current, category.id]
                                 : current.filter(c => c !== category.id);
                               field.onChange(next);
                             }}
                           />
                           <span className="font-semibold text-sm select-none">{category.label}</span>
                         </label>
                       )}
                     />
                   ))}
                 </div>
                 {form.formState.errors.categories && (
                   <p className="text-sm text-destructive font-medium">{form.formState.errors.categories.message}</p>
                 )}
               </div>
             </CardContent>
           </Card>

           <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
             {selectedCategories.includes("windows") && (
               <Card className="border-border shadow-sm">
                 <CardHeader className="border-b bg-muted/50 py-3">
                   <CardTitle className="text-base font-bold text-foreground">Window Specifications</CardTitle>
                 </CardHeader>
                 <CardContent className="p-4 space-y-4">
                   <div className="grid grid-cols-1 gap-3">
                     {["brand", "series", "exteriorColor", "interiorColor", "jambDepth", "dividedLites", "hardwareFinish", "screenColor"].map((field) => (
                       <div key={field} className="space-y-1.5">
                         <Label className="text-xs text-muted-foreground" htmlFor={`window.${field}`}>{field.replace(/([A-Z])/g, ' $1').replace(/^./, str => str.toUpperCase())}</Label>
                         <SpecInput 
                           id={`window.${field}`} 
                           className="h-8 text-sm"
                           options={optionsFor("window", field, form.watch("specs.window" as any) as any)}
                           {...form.register(`specs.window.${field}` as any)} 
                         />
                       </div>
                     ))}
                   </div>
                 </CardContent>
               </Card>
             )}

             {([
               ["interiorDoors", "interiorDoor", "Interior Doors", INTERIOR_DOOR_FIELDS],
               ["exteriorDoors", "exteriorDoor", "Exterior Doors", EXTERIOR_DOOR_FIELDS],
               ["doors", "door", "Doors (Legacy)", LEGACY_DOOR_FIELDS],
             ] as const).map(([category, specKey, title, fields]) =>
               selectedCategories.includes(category) && (
                 <Card key={category} className="border-border shadow-sm">
                   <CardHeader className="border-b bg-muted/50 py-3">
                     <CardTitle className="text-base font-bold text-foreground">{title}</CardTitle>
                   </CardHeader>
                   <CardContent className="p-4 space-y-4">
                     <div className="grid grid-cols-1 gap-3">
                       {fields.map((field) => (
                         <div key={field.key} className="space-y-1.5">
                           <Label className="text-xs text-muted-foreground" htmlFor={`${specKey}.${field.key}`}>{field.label}</Label>
                           <SpecInput 
                             id={`${specKey}.${field.key}`} 
                             className="h-8 text-sm"
                             options={optionsFor(specKey, field.key, form.watch(`specs.${specKey}` as any) as any)}
                             {...form.register(`specs.${specKey}.${field.key}` as any)} 
                           />
                         </div>
                       ))}
                     </div>
                     {specKey === "interiorDoor" && (() => {
                       const legacy = REMOVED_INTERIOR_DOOR_FIELDS.filter(
                         (f) => (quote.specs?.interiorDoor as Record<string, unknown> | null | undefined)?.[f.key],
                       );
                       if (legacy.length === 0) return null;
                       return (
                         <div className="pt-3 border-t border-border/50 space-y-2">
                           <p className="text-[10px] text-muted-foreground font-semibold uppercase tracking-wider">
                             Legacy Fields (Read-Only)
                           </p>
                           <div className="grid grid-cols-1 gap-2">
                             {legacy.map((f) => (
                               <div key={f.key} className="flex justify-between border-b border-border/50 pb-1">
                                 <span className="text-xs text-muted-foreground">{f.label}</span>
                                 <span className="text-xs text-foreground font-medium">
                                   {String((quote.specs?.interiorDoor as Record<string, unknown>)[f.key])}
                                 </span>
                               </div>
                             ))}
                           </div>
                         </div>
                       );
                     })()}
                   </CardContent>
                 </Card>
               )
             )}

             {selectedCategories.includes("trim") && (
               <Card className="border-border shadow-sm">
                 <CardHeader className="border-b bg-muted/50 py-3">
                   <CardTitle className="text-base font-bold text-foreground">Moulding Specs</CardTitle>
                 </CardHeader>
                 <CardContent className="p-4">
                   <Textarea 
                     id="trimDescription" 
                     {...form.register("specs.trimDescription")} 
                     placeholder="Enter moulding profiles, materials, lengths..."
                     className="h-40 resize-none text-sm"
                   />
                 </CardContent>
               </Card>
             )}

             {selectedCategories.includes("millwork") && (
               <Card className="border-border shadow-sm">
                 <CardHeader className="border-b bg-muted/50 py-3">
                   <CardTitle className="text-base font-bold text-foreground">Millwork Specs</CardTitle>
                 </CardHeader>
                 <CardContent className="p-4">
                   <Textarea 
                     id="millworkDescription" 
                     {...form.register("specs.millworkDescription")} 
                     placeholder="Enter custom millwork details..."
                     className="h-40 resize-none text-sm"
                   />
                 </CardContent>
               </Card>
             )}
             
             <Card className="border-border shadow-sm lg:col-span-2">
               <CardHeader className="border-b bg-muted/50 py-3">
                 <CardTitle className="text-base font-bold text-foreground">General Notes</CardTitle>
               </CardHeader>
               <CardContent className="p-4">
                 <Textarea 
                   {...form.register("notes")} 
                   placeholder="Overarching notes or delivery instructions..."
                   className="h-32 resize-none text-sm"
                 />
               </CardContent>
             </Card>
           </div>

           <div className="flex justify-end gap-3 pt-6 border-t">
             <Button type="button" variant="ghost" onClick={cancelEditing}>Cancel</Button>
             <Button type="submit" disabled={updateQuote.isPending} className="min-w-[120px]">
               {updateQuote.isPending ? "Saving..." : "Save Changes"}
             </Button>
           </div>
        </form>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-[1fr_380px] gap-6 lg:gap-10 items-start">
          {/* Main Content Area: Revisions & Updates */}
          <div className="space-y-6">
            <Card className="border-border shadow-md ring-1 ring-ring/5 overflow-hidden">
              <CardContent className="p-0">
                <form onSubmit={handleAddUpdate} className="flex flex-col">
                  <div className="p-4 border-b bg-muted">
                    <Label htmlFor="note" className="text-base font-bold text-foreground block mb-1">Add a revision to Quote #{quote.quoteNumber}</Label>
                    <p className="text-sm text-muted-foreground mb-3">{quote.customerName}{quote.projectName ? ` · ${quote.projectName}` : ""}</p>
                    <div className="flex flex-col sm:flex-row gap-3">
                      <div className="flex-1">
                        <Textarea 
                          id="note"
                          value={note}
                          onChange={e => setNote(e.target.value)}
                          placeholder="Describe the update, log a call, or note a change..."
                          className="min-h-[140px] resize-y text-base p-4 border-border focus-visible:ring-ring/20 placeholder:text-muted-foreground bg-card"
                          disabled={quote.archived}
                        />
                      </div>
                    </div>
                  </div>
                  <div className="bg-card px-4 py-3 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
                    <div className="flex-1 w-full min-w-0">
                      <span className="text-sm font-semibold text-muted-foreground block mb-2 sm:mb-1.5">Which products does this update concern?</span>
                      <p className="text-xs text-muted-foreground mb-2">{tags.length ? "Only the selected products are affected." : "No selection means a general update for all products."}</p>
                      <div className="flex flex-wrap gap-1.5">
                        {quote.categories.map((cat) => {
                          const selected = tags.includes(cat);
                          return (
                            <button
                              key={cat}
                              type="button"
                              disabled={quote.archived}
                              onClick={() =>
                                setTags((current) =>
                                  current.includes(cat)
                                    ? current.filter((t) => t !== cat)
                                    : [...current, cat],
                                )
                              }
                              className={`text-xs font-bold px-2.5 py-1 rounded-full border transition-colors ${
                                selected
                                  ? "border-slate-800 bg-slate-800 text-primary-foreground"
                                  : "border-border bg-card text-muted-foreground hover:bg-muted hover:text-foreground"
                              } disabled:opacity-50 disabled:cursor-not-allowed`}
                            >
                              {categoryLabel(cat)}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                    <div className="flex flex-col items-end gap-2 shrink-0">
                       <div className="flex items-center gap-2">
                         {hasDraft && (
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              className="text-muted-foreground hover:text-destructive h-9 px-2"
                              disabled={discardDraft.isPending || quote.archived}
                              onClick={handleDiscardDraft}
                              title="Discard draft"
                            >
                              <Trash2 className="w-4 h-4" />
                            </Button>
                          )}
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            className="h-9 bg-card"
                            disabled={saveDraft.isPending || !note.trim() || !isDirty || quote.archived}
                            onClick={handleSaveDraft}
                          >
                            <FileEdit className="w-4 h-4 mr-2 text-muted-foreground" />
                            Save Draft
                          </Button>
                          <Button type="submit" size="sm" className="h-9 min-w-[120px]" disabled={isPublishing || !note.trim() || quote.archived}>
                            {isPublishing ? "Adding..." : "Publish Update"}
                          </Button>
                       </div>
                       {(hasDraft || isDirty) && (
                         <span className="text-[10px] uppercase font-bold tracking-wider text-amber-600 flex items-center">
                           <Clock className="w-3 h-3 mr-1" />
                           {isDirty ? (saveDraft.isPending ? "Saving..." : "Unsaved") : "Draft saved"}
                         </span>
                       )}
                    </div>
                  </div>
                </form>
              </CardContent>
            </Card>

            <div className="pt-4">
              <div className="flex items-center justify-between pb-3 border-b border-border mb-6">
                <h3 className="text-sm font-bold uppercase tracking-wider text-muted-foreground">Revision History</h3>
                {revisions.length > 0 && (
                  <CopyButton
                    variant="ghost"
                    className="h-8 text-muted-foreground"
                    label="Copy text digest"
                    copiedLabel="Copied"
                    getText={() => formatRevisionsDigest(revisions)}
                  />
                )}
              </div>
              
              <div className="space-y-6 pl-2">
                {revisions.length === 0 ? (
                  <div className="text-center py-10 bg-muted rounded-lg border border-dashed border-border">
                    <MessageSquare className="w-8 h-8 mx-auto text-muted-foreground/70 mb-2" />
                    <p className="text-sm font-medium text-muted-foreground">No revisions logged yet.</p>
                  </div>
                ) : (
                  <div className="space-y-8">
                    <div className="relative before:absolute before:inset-0 before:ml-[15px] before:-translate-x-px md:before:mx-auto md:before:translate-x-0 before:h-full before:w-0.5 before:bg-gradient-to-b before:from-slate-200 before:to-transparent space-y-8">
                      {[...revisions].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime() || b.id - a.id).slice((revisionPage - 1) * REVISIONS_PER_PAGE, revisionPage * REVISIONS_PER_PAGE).map((rev) => (
                        <div key={rev.id} className="relative flex items-start md:justify-center">
                          <div className="absolute left-0 md:left-1/2 -ml-3 md:-ml-[13px] top-1 h-6 w-6 rounded-full border-4 border-white bg-slate-300 flex items-center justify-center shadow-sm z-10"></div>
                          <div className="ml-8 md:ml-0 md:w-full md:grid md:grid-cols-2 gap-8 w-full relative">
                             {/* Desktop alternating layout, mobile always right */}
                             <div className="md:col-start-2 md:col-span-1 bg-card border border-border p-4 rounded-xl shadow-sm hover:border-border transition-colors">
                                <div className="flex justify-between items-start mb-2">
                                  <div>
                                    <span className="font-bold text-sm text-foreground block">{rev.authorName}</span>
                                    <span className="text-xs font-medium text-muted-foreground">{format(new Date(rev.createdAt), "MMM d, yyyy 'at' h:mm a")}</span>
                                  </div>
                    <CopyButton variant="ghost" className="h-6 w-6 text-muted-foreground [&>svg]:w-3 [&>svg]:h-3 p-0" title="Copy note text" getText={() => rev.note} />
                                </div>
                                <p className="text-sm text-foreground whitespace-pre-wrap leading-relaxed mb-3">
                                  {rev.note}
                                </p>
                                {(rev.categories?.length ?? 0) > 0 && (
                                  <div className="flex flex-wrap gap-1.5 mt-3 pt-3 border-t border-border">
                                    {rev.categories!.map((tag) => (
                                      <Badge key={tag} variant="secondary" className="text-[10px] font-bold uppercase tracking-wider px-2 py-0 bg-muted text-muted-foreground">
                                        {categoryLabel(tag)}
                                      </Badge>
                                    ))}
                                  </div>
                                )}
                             </div>
                          </div>
                        </div>
                      ))}
                    </div>
                    {Math.ceil(revisions.length / REVISIONS_PER_PAGE) > 1 && (
                      <div className="flex items-center justify-between border-t border-border pt-4">
                        <Button 
                          variant="outline" 
                          size="sm" 
                          onClick={() => setRevisionPage(p => Math.max(1, p - 1))}
                          disabled={revisionPage === 1}
                          className="bg-card"
                        >
                          Newer
                        </Button>
                        <span className="text-xs font-medium text-muted-foreground">
                          Page {revisionPage} of {Math.ceil(revisions.length / REVISIONS_PER_PAGE)}
                        </span>
                        <Button 
                          variant="outline" 
                          size="sm" 
                          onClick={() => setRevisionPage(p => Math.min(Math.ceil(revisions.length / REVISIONS_PER_PAGE), p + 1))}
                          disabled={revisionPage === Math.ceil(revisions.length / REVISIONS_PER_PAGE)}
                          className="bg-card"
                        >
                          Older
                        </Button>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Sidebar: Details, Specs, Attachments */}
          <div className="space-y-6">
            
            {/* Scoped Approval Status Widget */}
            {activeTypes.length > 0 && (
              <Card className="border-border overflow-hidden shadow-sm">
                <div className="bg-primary text-primary-foreground p-3 flex items-center gap-2">
                  <CheckCircle className="w-4 h-4 text-muted-foreground/70" />
                  <h3 className="font-bold text-sm tracking-wide">Approval Status</h3>
                </div>
                <div className="p-3 bg-card space-y-2">
                  {activeTypes.map((type) => {
                    const item = coverage.find((candidate) => candidate.productType === type);
                    const status = item?.status ?? "open";
                    const copy = status === "signed" ? "Signed" : status === "needs_resigning" ? "Needs re-signing" : "Open";
                    
                    let indicator = "bg-muted border-border text-muted-foreground";
                    if (status === "signed") indicator = "bg-green-50 border-green-200 text-green-700";
                    if (status === "needs_resigning") indicator = "bg-amber-50 border-amber-200 text-amber-700";

                    return (
                      <div key={type} className={`flex items-center justify-between p-2 rounded border ${indicator} text-xs font-semibold`}>
                        <span>{productTypeLabel(type)}</span>
                        <span>{copy}</span>
                      </div>
                    );
                  })}
                  {legacyApproval && !quote.signed && !partiallyApproved && !fullyApproved && (
                    <div className="mt-2 p-2 rounded border border-amber-200 bg-amber-50 flex items-start gap-2">
                      <AlertCircle className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
                      <div className="text-xs text-amber-800">
                        <span className="font-bold block">Legacy record only.</span>
                        Must prepare new scoped approval.
                      </div>
                    </div>
                  )}
                  <div className="pt-2 space-y-2">
                    {signedSnapshots
                      .filter((approval) => coverage.some((item) => item.approvalId === approval.approvalId))
                      .map((approval) => {
                        const needsResigning = coverage.some(
                          (item) => item.approvalId === approval.approvalId && item.status === "needs_resigning",
                        );

                        return (
                          <Link
                            key={approval.approvalId}
                            href={`/scoped-sign/${approval.token}`}
                            className="group flex items-center gap-3 rounded-lg border border-border bg-background p-3 transition-colors hover:border-primary/40 hover:bg-muted/40"
                          >
                            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
                              <Printer className="h-4 w-4" />
                            </span>
                            <span className="min-w-0 flex-1">
                              <span className="block text-sm font-semibold text-foreground">
                                View or print signoff
                              </span>
                              <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                                {approval.productTypes.map(productTypeLabel).join(" · ")}
                              </span>
                              {needsResigning && (
                                <span className="mt-1 block text-xs font-medium text-amber-700">
                                  Original signed copy · Updates need re-signing
                                </span>
                              )}
                            </span>
                            <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-foreground" />
                          </Link>
                        );
                      })}
                    {(scopedApprovalData?.approvals ?? [])
                      .filter((approval) => approval.status === "open")
                      .map((approval) => (
                        <Link
                          key={approval.token}
                          href={`/scoped-sign/${approval.token}`}
                          className="group flex items-center gap-3 rounded-lg border border-dashed border-border bg-muted/30 p-3 transition-colors hover:border-primary/40 hover:bg-muted/60"
                        >
                          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
                            <FileText className="h-4 w-4" />
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="block text-sm font-semibold text-foreground">
                              Preview unsigned signoff
                            </span>
                            <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                              {approval.productTypes.map(productTypeLabel).join(" · ")}
                            </span>
                          </span>
                          <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-foreground" />
                        </Link>
                      ))}
                    <Button asChild variant="outline" size="sm" className="w-full text-xs font-bold bg-card">
                      <Link href={`/quotes/${quoteId}/signoff`}>
                        Manage Approvals
                      </Link>
                    </Button>
                  </div>
                </div>
              </Card>
            )}

            {/* Static Details Accordion */}
            <Card className="border-border shadow-sm overflow-hidden bg-card">
              <Accordion type="multiple" defaultValue={["specs"]} className="w-full">
                <AccordionItem value="specs" className="border-b-0">
                  <AccordionTrigger className="px-4 hover:bg-muted hover:no-underline">
                    <div className="flex items-center gap-2">
                      <span className="font-bold text-foreground">Product Specs</span>
                    </div>
                  </AccordionTrigger>
                  <AccordionContent className="px-4 pb-4">
                    <div className="space-y-6">
                      {quote.categories.includes("windows") && (
                        <div>
                          <h4 className="text-[11px] uppercase font-bold tracking-wider text-muted-foreground mb-2 border-b pb-1">Windows</h4>
                          {renderSpecGrid(quote.specs?.window)}
                        </div>
                      )}
                      {quote.categories.includes("interiorDoors") && (
                        <div>
                          <h4 className="text-[11px] uppercase font-bold tracking-wider text-muted-foreground mb-2 border-b pb-1">Interior Doors</h4>
                          {renderSpecGrid(quote.specs?.interiorDoor)}
                        </div>
                      )}
                      {quote.categories.includes("exteriorDoors") && (
                        <div>
                          <h4 className="text-[11px] uppercase font-bold tracking-wider text-muted-foreground mb-2 border-b pb-1">Exterior Doors</h4>
                          {renderSpecGrid(quote.specs?.exteriorDoor)}
                        </div>
                      )}
                      {quote.categories.includes("doors") && (
                        <div>
                          <h4 className="text-[11px] uppercase font-bold tracking-wider text-muted-foreground mb-2 border-b pb-1">Doors (Legacy)</h4>
                          {renderSpecGrid(quote.specs?.door)}
                        </div>
                      )}
                      {quote.categories.includes("trim") && (
                        <div>
                          <h4 className="text-[11px] uppercase font-bold tracking-wider text-muted-foreground mb-2 border-b pb-1">Moulding</h4>
                          <p className="text-sm font-medium whitespace-pre-wrap">{quote.specs?.trimDescription || "—"}</p>
                        </div>
                      )}
                      {quote.categories.includes("millwork") && (
                        <div>
                          <h4 className="text-[11px] uppercase font-bold tracking-wider text-muted-foreground mb-2 border-b pb-1">Millwork</h4>
                          <p className="text-sm font-medium whitespace-pre-wrap">{quote.specs?.millworkDescription || "—"}</p>
                        </div>
                      )}
                      {quote.notes && (
                        <div>
                          <h4 className="text-[11px] uppercase font-bold tracking-wider text-muted-foreground mb-2 border-b pb-1">General Notes</h4>
                          <p className="text-sm font-medium whitespace-pre-wrap">{quote.notes}</p>
                        </div>
                      )}
                    </div>
                  </AccordionContent>
                </AccordionItem>
              </Accordion>
            </Card>

            <AttachmentsCard quoteId={quoteId} readOnly={quote.archived} />

            {!quote.archived ? (
               <div className="flex justify-end">
                 <Button variant="ghost" size="sm" className="text-muted-foreground hover:text-muted-foreground text-xs" onClick={() => setIsArchiveDialogOpen(true)}>
                   <Archive className="w-3.5 h-3.5 mr-1.5" /> Archive Quote
                 </Button>
               </div>
            ) : (
              <Card className="border-border bg-muted">
                <CardContent className="p-4 space-y-2">
                  <h3 className="text-sm font-bold text-foreground flex items-center gap-2">
                    <Archive className="w-4 h-4 text-muted-foreground" /> Archived Quote
                  </h3>
                  <p className="text-xs text-muted-foreground font-medium">
                    {quote.archivedByName ? `By ${quote.archivedByName}` : "Archived"}
                    {quote.archivedAt ? ` on ${format(new Date(quote.archivedAt), "MMM d, yyyy")}` : ""}
                  </p>
                  {quote.archiveReason && (
                    <p className="text-xs text-foreground italic border-l-2 border-border pl-2 mt-2">
                      "{quote.archiveReason}"
                    </p>
                  )}
                  <Button variant="outline" size="sm" className="w-full mt-3 bg-card" onClick={handleUnarchive} disabled={unarchiveQuote.isPending}>
                    <ArchiveRestore className="w-3.5 h-3.5 mr-2 text-muted-foreground" />
                    Restore Quote
                  </Button>
                </CardContent>
              </Card>
            )}

          </div>
        </div>
      )}

      {/* Modals */}
      <Dialog open={isArchiveDialogOpen} onOpenChange={(open) => { setIsArchiveDialogOpen(open); if (!open) setArchiveReason(""); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Archive className="w-5 h-5" /> Archive Quote
            </DialogTitle>
            <DialogDescription className="text-base text-foreground mt-2">
              The quote and its full history are kept — it just moves out of the active list. You can restore it anytime.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2 mt-2">
            <Label htmlFor="archiveReason">Reason for archiving</Label>
            <Textarea
              id="archiveReason"
              value={archiveReason}
              onChange={e => setArchiveReason(e.target.value)}
              placeholder="e.g. Project on hold, customer went another direction..."
              className="min-h-[100px] resize-none"
            />
          </div>
          <DialogFooter className="mt-4">
            <Button variant="ghost" onClick={() => setIsArchiveDialogOpen(false)}>Cancel</Button>
            <Button onClick={handleArchive} disabled={archiveQuote.isPending || !archiveReason.trim()}>
              {archiveQuote.isPending ? "Archiving..." : "Archive Quote"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={isRevisionWarningOpen} onOpenChange={setIsRevisionWarningOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="text-destructive flex items-center gap-2">
              <AlertCircle className="w-5 h-5" /> Signature Warning
            </DialogTitle>
            <DialogDescription className="text-base text-foreground mt-4">
              This quote is already signed. Adding a new revision will <strong>invalidate the customer's signature</strong>, and the quote will need to be signed off again.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="mt-6">
            <Button variant="ghost" onClick={() => setIsRevisionWarningOpen(false)}>Cancel</Button>
            <Button variant="destructive" onClick={executeAddUpdate} disabled={isPublishing}>
              {isPublishing ? "Publishing..." : "Remove Signature & Publish"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!pendingNavHref} onOpenChange={(open) => !open && setPendingNavHref(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-amber-700">
              <AlertCircle className="w-5 h-5" /> Unsaved Draft
            </DialogTitle>
            <DialogDescription className="text-base text-foreground mt-2">
              Your update hasn't been saved yet.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="mt-4 gap-2">
            <Button variant="ghost" onClick={() => setPendingNavHref(null)}>Stay here</Button>
            <Button
              variant="outline"
              className="text-destructive border-destructive hover:bg-destructive/5"
              onClick={() => {
                const dest = pendingNavHref!;
                setPendingNavHref(null);
                setNote(savedDraftNote ?? "");
                setTags(savedDraftTags ?? []);
                composerRef.current = { note: savedDraftNote ?? "", savedDraftNote, tags: savedDraftTags ?? [] };
                setLocation(dest);
              }}
            >
              Discard & Leave
            </Button>
            <Button
              disabled={saveDraft.isPending}
              onClick={() => {
                const dest = pendingNavHref!;
                persistDraft(note, {
                  silent: true,
                  onSuccess: () => {
                    setPendingNavHref(null);
                    composerRef.current = { note, savedDraftNote: note, tags };
                    setLocation(dest);
                  },
                });
              }}
            >
              {saveDraft.isPending ? "Saving..." : "Save Draft & Leave"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!pendingData} onOpenChange={(open) => !open && setPendingData(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="text-destructive flex items-center gap-2">
              <AlertCircle className="w-5 h-5" /> Signature Warning
            </DialogTitle>
            <DialogDescription className="text-base text-foreground mt-4">
              Editing these details will <strong>remove the customer's signature</strong>. They will need to sign off again.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="mt-6">
            <Button variant="ghost" onClick={() => setPendingData(null)}>Cancel</Button>
            <Button variant="destructive" onClick={() => pendingData && executeSave(pendingData)} disabled={updateQuote.isPending}>
              {updateQuote.isPending ? "Saving..." : "Remove Signature & Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Shell>
  );
}