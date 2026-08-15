import { useEffect, useRef, useState } from "react";
import { useLocation, useParams, Link } from "wouter";
import { format } from "date-fns";
import { useQueryClient } from "@tanstack/react-query";
import { useForm, Controller } from "react-hook-form";
import { z } from "zod";
import { zodResolver } from "@hookform/resolvers/zod";
import { Printer, PenTool, CheckCircle, AlertCircle, MessageSquare, ArrowLeft, Edit, Paperclip, Upload, Download, Trash2, FileImage, FileText, FileEdit, Archive, ArchiveRestore } from "lucide-react";
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
  usePublishRevisionDraft
} from "@workspace/api-client-react";
import { useUpload } from "@workspace/object-storage-web";
import { Shell } from "@/components/layout";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
    <Card>
      <CardHeader className="pb-4">
        <CardTitle className="flex items-center gap-2">
          <Paperclip className="w-5 h-5" />
          Attachments
        </CardTitle>
      </CardHeader>
      <CardContent className="pt-0 space-y-4">
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="hidden"
          accept="image/*,.pdf,.dwg,.dxf,.doc,.docx,.xls,.xlsx"
          onChange={(e) => handleFiles(e.target.files)}
        />
        {!readOnly && (
          <Button
            variant="outline"
            className="w-full"
            disabled={isUploading}
            onClick={() => fileInputRef.current?.click()}
          >
            <Upload className="w-4 h-4 mr-2" />
            {isUploading ? `Uploading... ${progress}%` : "Upload Drawings or Photos"}
          </Button>
        )}

        {isLoading ? (
          <p className="text-center text-sm text-muted-foreground font-medium py-2">Loading attachments...</p>
        ) : attachments.length === 0 ? (
          <p className="text-center text-sm text-muted-foreground font-medium py-2">
            No files attached yet. Add shop drawings, sketches, or job-site photos.
          </p>
        ) : (
          <ul className="space-y-2">
            {attachments.map((att) => {
              const isImage = att.contentType?.startsWith("image/");
              const sizeLabel = formatFileSize(att.size);
              return (
                <li
                  key={att.id}
                  className="flex items-center gap-3 p-3 border-2 border-border rounded-lg bg-card"
                >
                  {isImage ? (
                    <FileImage className="w-5 h-5 text-primary shrink-0" />
                  ) : (
                    <FileText className="w-5 h-5 text-primary shrink-0" />
                  )}
                  <div className="flex-1 min-w-0">
                    <p className="font-bold text-sm text-foreground truncate" title={att.name}>{att.name}</p>
                    <p className="text-xs text-muted-foreground font-medium">
                      {att.uploadedByName} · {format(new Date(att.createdAt), "MMM d, yyyy")}
                      {sizeLabel ? ` · ${sizeLabel}` : ""}
                    </p>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <Button asChild variant="ghost" size="sm" className="h-8 w-8 p-0" title="Download">
                      <a href={`/api/storage${att.objectPath}`} download={att.name} target="_blank" rel="noreferrer">
                        <Download className="w-4 h-4" />
                      </a>
                    </Button>
                    {!readOnly && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-8 w-8 p-0 text-destructive hover:text-destructive"
                        title="Remove"
                        disabled={deleteAttachment.isPending}
                        onClick={() => handleDelete(att.id, att.name)}
                      >
                        <Trash2 className="w-4 h-4" />
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

  // Draft-write coordination: ALL draft mutations (save, discard, publish)
  // run through a single promise-chain queue, so at most one request is in
  // flight and the server always sees writes in the order the user made
  // them. Destructive actions (publish, discard) additionally bump the
  // epoch: any queued-but-not-yet-dispatched save checks the epoch at its
  // turn and is dropped before dispatch, so a stale auto-save can never
  // reach the server after a publish or discard, and never resurrects a
  // deleted draft.
  const writeEpochRef = useRef(0);
  const writeChainRef = useRef<Promise<unknown>>(Promise.resolve());

  const enqueueDraftWrite = <T,>(fn: () => Promise<T>): Promise<T> => {
    const run = writeChainRef.current.then(fn);
    // The chain itself swallows failures so one failed write doesn't wedge
    // the queue; callers observe errors through the returned promise.
    writeChainRef.current = run.catch(() => undefined);
    return run;
  };
  const enqueueDraftWriteRef = useRef(enqueueDraftWrite);
  enqueueDraftWriteRef.current = enqueueDraftWrite;

  const persistDraft = (text: string, opts?: { silent?: boolean; onSuccess?: () => void }) => {
    const epoch = writeEpochRef.current;
    const draftTags = composerRef.current.tags;
    enqueueDraftWrite(async () => {
      // Superseded (published/discarded) while queued: never dispatched.
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

  // Auto-save: quietly persist typing as a draft after a short pause.
  // Skipped while a publish is in flight, and epoch-checked so a late timer
  // can't re-create a draft that publish or discard just consumed.
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

  // Warn before leaving the page with unsaved typing (browser close/reload).
  useEffect(() => {
    if (!isDirty) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [isDirty]);

  // Guard in-app navigation: intercept clicks on internal links while the
  // composer has unsaved typing and ask before leaving. (Back/forward and
  // programmatic navigation are covered by the unmount flush above.)
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

  const { quote, revisions, signoff } = detail;
  const selectedCategories = form.watch("categories") || [];

  const handleAddUpdate = (e: React.FormEvent) => {
    e.preventDefault();
    if (!note.trim()) return;
    // Adding a revision invalidates an existing signature — confirm first.
    if (quote.signed) {
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
    toast({ title: "Update added", description: "The revision log has been updated." });
    queryClient.invalidateQueries({ queryKey: getGetQuoteQueryKey(quoteId) });
    queryClient.invalidateQueries({ queryKey: getListQuotesQueryKey() });
    queryClient.invalidateQueries({ queryKey: getGetRevisionDraftQueryKey(quoteId) });
  };

  const publishError = () => {
    toast({ title: "Error", description: "Failed to add update.", variant: "destructive" });
  };

  const executeAddUpdate = () => {
    // Single atomic request: the server publishes the provided text and
    // deletes any stored draft in one transaction. Bumping the epoch drops
    // any queued-but-undispatched auto-save, and enqueueing the publish
    // orders it after every already-dispatched save.
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
    // Bump the epoch (drops queued auto-saves before dispatch) and enqueue
    // the DELETE after any already-dispatched save, so a delayed PUT can't
    // land after the DELETE and resurrect the discarded draft.
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
    if (quote.signed) {
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
    // Prefix match: refreshes recent-activity queries for all param variants.
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
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-3">
        {entries.map(([k, v]) => (
          <div key={k} className="flex flex-col border-b-2 border-border/50 pb-2">
            <span className="text-xs text-muted-foreground font-bold uppercase tracking-wider">
              {k.replace(/([A-Z])/g, ' $1').trim()}
            </span>
            <span className="text-foreground font-medium">{v}</span>
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
            <div className="flex items-center gap-3 mb-2">
              <h1 className="text-4xl font-serif font-bold text-primary">{quote.quoteNumber}</h1>
              {quote.archived ? (
                <Badge variant="outline" className="text-sm px-3 py-1 text-muted-foreground">Archived</Badge>
              ) : quote.signed ? (
                <Badge variant="success" className="text-sm px-3 py-1">Signed</Badge>
              ) : (
                <Badge variant="warning" className="text-sm px-3 py-1">Awaiting Signoff</Badge>
              )}
            </div>
            <p className="text-xl font-medium text-foreground">{quote.displayName}</p>
            <p className="text-sm text-muted-foreground mt-1">{quote.jobAddress}</p>
          </div>
          
          <div className="flex flex-wrap items-center gap-3">
            {quote.archived ? (
              <Button variant="outline" className="bg-card" onClick={handleUnarchive} disabled={unarchiveQuote.isPending}>
                <ArchiveRestore className="w-4 h-4 mr-2" />
                {unarchiveQuote.isPending ? "Restoring..." : "Restore"}
              </Button>
            ) : (
              <Button variant="outline" className="bg-card" onClick={() => setIsArchiveDialogOpen(true)} disabled={isEditing}>
                <Archive className="w-4 h-4 mr-2" />
                Archive
              </Button>
            )}
            <Button asChild variant="outline" className="bg-card" disabled={isEditing}>
              <Link href={`/quotes/${quote.id}/print-log`}>
                <Printer className="w-4 h-4 mr-2" />
                Print Log
              </Link>
            </Button>
            {quote.archived && !quote.signed ? (
              <Button disabled title="Archived quotes can't be signed. Restore the quote first.">
                <PenTool className="w-4 h-4 mr-2" />
                Signoff Document
              </Button>
            ) : (
              <Button asChild className={quote.signed ? "bg-green-700 hover:bg-green-800" : ""} disabled={isEditing}>
                <Link href={`/quotes/${quote.id}/signoff`}>
                  <PenTool className="w-4 h-4 mr-2" />
                  {quote.signed ? "View Signoff" : "Signoff Document"}
                </Link>
              </Button>
            )}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-5 gap-8">
        <div className="lg:col-span-3 space-y-8">
          {isEditing ? (
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-8 animate-in fade-in slide-in-from-bottom-2 duration-300">
              <Card>
                <CardHeader className="flex flex-row items-center justify-between pb-4 border-b-2 border-border mb-6">
                  <CardTitle>Edit Quote Information</CardTitle>
                </CardHeader>
                <CardContent className="space-y-6">
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
                    <div className="space-y-2">
                      <Label htmlFor="quoteNumber">BisTrack Quote #</Label>
                      <p className="text-xs text-muted-foreground">7-digit number from BisTrack</p>
                      <Input 
                        id="quoteNumber" 
                        placeholder="e.g. 1234567" 
                        inputMode="numeric"
                        maxLength={7}
                        {...form.register("quoteNumber")} 
                      />
                      {form.formState.errors.quoteNumber && (
                        <p className="text-sm text-destructive font-medium">{form.formState.errors.quoteNumber.message}</p>
                      )}
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="customerName">Customer Name</Label>
                      <div className="h-4"></div>
                      <Input 
                        id="customerName" 
                        placeholder="e.g. John Doe / Acme Builders" 
                        {...form.register("customerName")} 
                      />
                      {form.formState.errors.customerName && (
                        <p className="text-sm text-destructive font-medium">{form.formState.errors.customerName.message}</p>
                      )}
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="projectName">Project Name</Label>
                      <Input 
                        id="projectName" 
                        placeholder="e.g. Main Street Renovation" 
                        {...form.register("projectName")} 
                      />
                      {form.formState.errors.projectName && (
                        <p className="text-sm text-destructive font-medium">{form.formState.errors.projectName.message}</p>
                      )}
                    </div>
                    <div className="space-y-2">
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
                        <p className="text-sm text-destructive font-medium">{form.formState.errors.jobAddress.message}</p>
                      )}
                    </div>
                  </div>

                  <div className="space-y-4 pt-4 border-t-2 border-border">
                    <Label className="text-lg">Product Categories</Label>
                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                      {/* Legacy "Doors" stays selectable only on quotes that already use it. */}
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
                              className={`flex items-center gap-3 p-4 border-2 rounded-lg cursor-pointer transition-colors ${
                                field.value?.includes(category.id) ? 'border-primary bg-primary/5' : 'border-border bg-card hover:bg-accent/50'
                              }`}
                            >
                              <Checkbox 
                                checked={field.value?.includes(category.id)}
                                onCheckedChange={(checked) => {
                                  const current = field.value || [];
                                  const next = checked 
                                    ? [...current, category.id]
                                    : current.filter(c => c !== category.id);
                                  field.onChange(next);
                                }}
                              />
                              <span className="font-bold select-none">{category.label}</span>
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

              {selectedCategories.includes("windows") && (
                <Card>
                  <CardContent className="p-6 sm:p-8 space-y-6">
                    <h3 className="text-xl font-serif font-bold text-foreground border-b-2 border-border pb-2">Window Specifications</h3>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                      {["brand", "series", "exteriorColor", "interiorColor", "jambDepth", "dividedLites", "hardwareFinish", "screenColor"].map((field) => (
                        <div key={field} className="space-y-2">
                          <Label htmlFor={`window.${field}`}>{field.replace(/([A-Z])/g, ' $1').replace(/^./, str => str.toUpperCase())}</Label>
                          <SpecInput 
                            id={`window.${field}`} 
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
                ["interiorDoors", "interiorDoor", "Interior Door Specifications", INTERIOR_DOOR_FIELDS],
                ["exteriorDoors", "exteriorDoor", "Exterior Door Specifications", EXTERIOR_DOOR_FIELDS],
                ["doors", "door", "Door Specifications (Legacy)", LEGACY_DOOR_FIELDS],
              ] as const).map(([category, specKey, title, fields]) =>
                selectedCategories.includes(category) && (
                  <Card key={category}>
                    <CardContent className="p-6 sm:p-8 space-y-6">
                      <h3 className="text-xl font-serif font-bold text-foreground border-b-2 border-border pb-2">{title}</h3>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                        {fields.map((field) => (
                          <div key={field.key} className="space-y-2">
                            <Label htmlFor={`${specKey}.${field.key}`}>{field.label}</Label>
                            <SpecInput 
                              id={`${specKey}.${field.key}`} 
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
                        // Previously saved values for fields no longer on the
                        // interior door form: shown read-only, preserved on save.
                        return (
                          <div className="pt-2 border-t border-border/50 space-y-2">
                            <p className="text-xs text-muted-foreground font-medium">
                              Previously saved values (read-only — these fields no longer apply to interior doors but are kept with the quote):
                            </p>
                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-2">
                              {legacy.map((f) => (
                                <div key={f.key} className="flex flex-col">
                                  <span className="text-xs text-muted-foreground font-bold uppercase tracking-wider">{f.label}</span>
                                  <span className="text-foreground font-medium">
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
                <Card>
                  <CardContent className="p-6 sm:p-8 space-y-4">
                    <h3 className="text-xl font-serif font-bold text-foreground border-b-2 border-border pb-2">Moulding Specifications</h3>
                    <div className="space-y-2">
                      <Label htmlFor="trimDescription">Description / Details</Label>
                      <Textarea 
                        id="trimDescription" 
                        {...form.register("specs.trimDescription")} 
                        placeholder="Enter moulding profiles, materials, lengths..."
                        className="h-32"
                      />
                    </div>
                  </CardContent>
                </Card>
              )}

              {selectedCategories.includes("millwork") && (
                <Card>
                  <CardContent className="p-6 sm:p-8 space-y-4">
                    <h3 className="text-xl font-serif font-bold text-foreground border-b-2 border-border pb-2">Millwork Specifications</h3>
                    <div className="space-y-2">
                      <Label htmlFor="millworkDescription">Description / Details</Label>
                      <Textarea 
                        id="millworkDescription" 
                        {...form.register("specs.millworkDescription")} 
                        placeholder="Enter custom millwork details, cabinetry..."
                        className="h-32"
                      />
                    </div>
                  </CardContent>
                </Card>
              )}

              <Card>
                <CardContent className="p-6 sm:p-8 space-y-4">
                  <h3 className="text-xl font-serif font-bold text-foreground border-b-2 border-border pb-2">General Notes</h3>
                  <div className="space-y-2">
                    <Textarea 
                      {...form.register("notes")} 
                      placeholder="Any overarching notes or delivery instructions..."
                      className="h-32"
                    />
                  </div>
                </CardContent>
              </Card>

              <div className="flex justify-end gap-4 pt-4">
                <Button type="button" variant="outline" size="lg" onClick={cancelEditing}>
                  Cancel
                </Button>
                <Button type="submit" size="lg" disabled={updateQuote.isPending} className="px-10">
                  {updateQuote.isPending ? "Saving..." : "Save Changes"}
                </Button>
              </div>
            </form>
          ) : (
            <Card>
              <CardHeader className="flex flex-row items-center justify-between pb-4">
                <CardTitle>Quote Details</CardTitle>
                {!quote.archived && (
                  <Button variant="outline" size="sm" onClick={startEditing}>
                    <Edit className="w-4 h-4 mr-2" /> Edit Quote
                  </Button>
                )}
              </CardHeader>
              <CardContent className="space-y-8 pt-6">
                {quote.categories.includes("windows") && (
                  <div className="space-y-3">
                    <h3 className="text-lg font-serif font-bold text-primary bg-primary/5 px-3 py-1 rounded">Windows</h3>
                    <div className="px-3">
                      {renderSpecGrid(quote.specs?.window)}
                    </div>
                  </div>
                )}
                {quote.categories.includes("interiorDoors") && (
                  <div className="space-y-3">
                    <h3 className="text-lg font-serif font-bold text-primary bg-primary/5 px-3 py-1 rounded">Interior Doors</h3>
                    <div className="px-3">
                      {renderSpecGrid(quote.specs?.interiorDoor)}
                    </div>
                  </div>
                )}
                {quote.categories.includes("exteriorDoors") && (
                  <div className="space-y-3">
                    <h3 className="text-lg font-serif font-bold text-primary bg-primary/5 px-3 py-1 rounded">Exterior Doors</h3>
                    <div className="px-3">
                      {renderSpecGrid(quote.specs?.exteriorDoor)}
                    </div>
                  </div>
                )}
                {quote.categories.includes("doors") && (
                  <div className="space-y-3">
                    <h3 className="text-lg font-serif font-bold text-primary bg-primary/5 px-3 py-1 rounded">Doors</h3>
                    <div className="px-3">
                      {renderSpecGrid(quote.specs?.door)}
                    </div>
                  </div>
                )}
                {quote.categories.includes("trim") && (
                  <div className="space-y-3">
                    <h3 className="text-lg font-serif font-bold text-primary bg-primary/5 px-3 py-1 rounded">Moulding</h3>
                    <div className="px-3">
                      <p className="whitespace-pre-wrap text-foreground font-medium">{quote.specs?.trimDescription || <span className="text-muted-foreground italic">No details</span>}</p>
                    </div>
                  </div>
                )}
                {quote.categories.includes("millwork") && (
                  <div className="space-y-3">
                    <h3 className="text-lg font-serif font-bold text-primary bg-primary/5 px-3 py-1 rounded">Millwork</h3>
                    <div className="px-3">
                      <p className="whitespace-pre-wrap text-foreground font-medium">{quote.specs?.millworkDescription || <span className="text-muted-foreground italic">No details</span>}</p>
                    </div>
                  </div>
                )}
                {quote.notes && (
                  <div className="space-y-3 pt-4 border-t-2 border-border">
                    <h3 className="text-lg font-serif font-bold text-foreground px-3">General Notes</h3>
                    <div className="px-3">
                      <p className="whitespace-pre-wrap text-foreground font-medium">{quote.notes}</p>
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>
          )}
        </div>

        <div className="lg:col-span-2 space-y-8">
          {quote.archived && (
            <Card className="border-border bg-muted/40">
              <CardContent className="p-6 space-y-2">
                <h3 className="text-lg font-bold text-foreground flex items-center gap-2">
                  <Archive className="w-5 h-5" /> Archived
                </h3>
                <p className="text-sm text-muted-foreground font-medium">
                  {quote.archivedByName ? `By ${quote.archivedByName}` : "Archived"}
                  {quote.archivedAt ? ` on ${format(new Date(quote.archivedAt), "MMM d, yyyy")}` : ""}
                </p>
                {quote.archiveReason && (
                  <p className="text-sm text-foreground font-medium italic border-l-2 border-border pl-3 whitespace-pre-wrap">
                    "{quote.archiveReason}"
                  </p>
                )}
              </CardContent>
            </Card>
          )}

          {quote.signed && signoff && !isEditing && (
            <Card className="border-green-700/30 bg-green-700/5">
              <CardContent className="p-6 flex flex-col items-center text-center space-y-3">
                <CheckCircle className="w-12 h-12 text-green-700" />
                <div>
                  <h3 className="text-lg font-bold text-green-800">Signed & Approved</h3>
                  <p className="text-sm text-green-700 font-medium">
                    By {signoff.customerName} on {format(new Date(signoff.signedAt), "MMM d, yyyy")}
                  </p>
                </div>
                <Button asChild variant="outline" size="sm" className="w-full mt-2 border-green-700/30 text-green-800 hover:bg-green-700/10">
                  <Link href={`/quotes/${quote.id}/signoff`}>View Document</Link>
                </Button>
              </CardContent>
            </Card>
          )}

          <AttachmentsCard quoteId={quoteId} readOnly={quote.archived} />

          <Card>
            <CardHeader className="pb-4">
              <div className="flex items-center justify-between gap-2">
                <CardTitle className="flex items-center gap-2">
                  <MessageSquare className="w-5 h-5" />
                  Revision Log
                </CardTitle>
                {revisions.length > 0 && (
                  <CopyButton
                    variant="outline"
                    label="Copy log"
                    copiedLabel="Copied"
                    title="Copy the full revision log as plain text"
                    getText={() => formatRevisionsDigest(revisions)}
                  />
                )}
              </div>
            </CardHeader>
            <CardContent className="pt-0 flex flex-col h-[720px]">
              <div className="flex-1 overflow-y-auto pr-2 space-y-6 mb-4">
                {revisions.length === 0 ? (
                  <div className="text-center py-8 text-muted-foreground font-medium">
                    No updates logged yet.
                  </div>
                ) : (
                  <div className="relative border-l-2 border-border ml-3 pl-6 py-2 space-y-8">
                    {revisions.map(rev => (
                      <div key={rev.id} className="relative">
                        <div className="absolute -left-[35px] top-1 w-4 h-4 rounded-full bg-secondary ring-4 ring-card"></div>
                        <div className="space-y-1.5">
                          <div className="flex items-baseline justify-between gap-2">
                            <span className="font-bold text-foreground">{rev.authorName}</span>
                            <div className="flex items-center gap-1.5 shrink-0">
                              <span className="text-xs text-muted-foreground font-bold">{format(new Date(rev.createdAt), "MMM d, h:mm a")}</span>
                              <CopyButton title="Copy note text" getText={() => rev.note} />
                            </div>
                          </div>
                          {(rev.categories?.length ?? 0) > 0 && (
                            <div className="flex flex-wrap gap-1.5">
                              {rev.categories!.map((tag) => (
                                <Badge key={tag} variant="outline" className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5">
                                  {categoryLabel(tag)}
                                </Badge>
                              ))}
                            </div>
                          )}
                          <p className="text-foreground font-medium bg-muted/30 p-4 rounded-md border-2 border-border/50 text-[15px] leading-relaxed whitespace-pre-wrap">
                            {rev.note}
                          </p>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
              
              <form onSubmit={handleAddUpdate} className="mt-auto pt-4 border-t-2 border-border space-y-3">
                {(hasDraft || isDirty) && (
                  <div className="flex items-center justify-between gap-2">
                    <Badge variant="outline" className="text-xs font-bold uppercase tracking-wider text-amber-700 border-amber-400 bg-amber-50">
                      <FileEdit className="w-3 h-3 mr-1" />
                      Draft — not published
                    </Badge>
                    <span className="text-xs text-muted-foreground font-medium">
                      {isDirty
                        ? (saveDraft.isPending ? "Saving draft..." : "Unsaved changes")
                        : "Draft saved — only you can see it"}
                    </span>
                  </div>
                )}
                <div className="space-y-1.5">
                  <span className="text-xs font-bold uppercase tracking-wider text-muted-foreground">
                    Tag categories (optional — untagged applies to the whole quote)
                  </span>
                  <div className="flex flex-wrap gap-1.5">
                    {quote.categories.map((cat) => {
                      const selected = tags.includes(cat);
                      return (
                        <button
                          key={cat}
                          type="button"
                          disabled={isEditing || quote.archived}
                          onClick={() =>
                            setTags((current) =>
                              current.includes(cat)
                                ? current.filter((t) => t !== cat)
                                : [...current, cat],
                            )
                          }
                          className={`text-xs font-bold px-2.5 py-1 rounded-full border-2 transition-colors ${
                            selected
                              ? "border-primary bg-primary/10 text-primary"
                              : "border-border bg-card text-muted-foreground hover:bg-accent/50"
                          } disabled:opacity-50 disabled:cursor-not-allowed`}
                        >
                          {categoryLabel(cat)}
                        </button>
                      );
                    })}
                  </div>
                </div>
                <Label htmlFor="note" className="sr-only">Add an update</Label>
                <Textarea 
                  id="note"
                  value={note}
                  onChange={e => setNote(e.target.value)}
                  placeholder="Log a change, conversation, or decision... (multi-line notes welcome)"
                  className="min-h-[320px] resize-y text-base leading-relaxed p-4"
                  disabled={isEditing || quote.archived}
                />
                <div className="flex gap-2">
                  <Button type="submit" className="flex-1" disabled={isPublishing || !note.trim() || isEditing || quote.archived}>
                    {isPublishing ? "Publishing..." : "Publish Update"}
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    disabled={saveDraft.isPending || !note.trim() || !isDirty || isEditing || quote.archived}
                    onClick={handleSaveDraft}
                  >
                    <FileEdit className="w-4 h-4 mr-2" />
                    Save Draft
                  </Button>
                  {hasDraft && (
                    <Button
                      type="button"
                      variant="ghost"
                      className="text-destructive hover:text-destructive"
                      disabled={discardDraft.isPending || isEditing || quote.archived}
                      onClick={handleDiscardDraft}
                      title="Discard draft"
                    >
                      <Trash2 className="w-4 h-4" />
                    </Button>
                  )}
                </div>
              </form>
            </CardContent>
          </Card>
        </div>
      </div>

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
            <Button variant="outline" onClick={() => setIsArchiveDialogOpen(false)}>Cancel</Button>
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
              <AlertCircle className="w-5 h-5" /> Warning: Signature Removal
            </DialogTitle>
            <DialogDescription className="text-base text-foreground mt-4">
              This quote is already signed. Adding a new revision will remove the customer's signature, and the quote will need to be signed off again.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="mt-6">
            <Button variant="outline" onClick={() => setIsRevisionWarningOpen(false)}>Cancel</Button>
            <Button variant="destructive" onClick={executeAddUpdate} disabled={isPublishing}>
              {isPublishing ? "Publishing..." : "Remove Signature & Publish Update"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!pendingNavHref} onOpenChange={(open) => !open && setPendingNavHref(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertCircle className="w-5 h-5 text-amber-600" /> Unsaved Changes
            </DialogTitle>
            <DialogDescription className="text-base text-foreground mt-2">
              Your update hasn't been saved as a draft yet. Save it before leaving so you don't lose your text.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="mt-4 gap-2">
            <Button variant="outline" onClick={() => setPendingNavHref(null)}>Stay</Button>
            <Button
              variant="ghost"
              className="text-destructive hover:text-destructive"
              onClick={() => {
                const dest = pendingNavHref!;
                setPendingNavHref(null);
                setNote(savedDraftNote ?? "");
                setTags(savedDraftTags ?? []);
                // Update the ref synchronously so the unmount flush doesn't
                // re-save the text the user chose to abandon.
                composerRef.current = { note: savedDraftNote ?? "", savedDraftNote, tags: savedDraftTags ?? [] };
                setLocation(dest);
              }}
            >
              Leave Without Saving
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
              <AlertCircle className="w-5 h-5" /> Warning: Signature Removal
            </DialogTitle>
            <DialogDescription className="text-base text-foreground mt-4">
              Saving these changes will remove the customer's signature — they'll need to sign off again. The edit will be recorded in the revision log.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="mt-6">
            <Button variant="outline" onClick={() => setPendingData(null)}>Cancel</Button>
            <Button variant="destructive" onClick={() => pendingData && executeSave(pendingData)} disabled={updateQuote.isPending}>
              {updateQuote.isPending ? "Saving..." : "Remove Signature & Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Shell>
  );
}