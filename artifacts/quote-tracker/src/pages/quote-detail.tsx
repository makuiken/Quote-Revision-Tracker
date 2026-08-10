import { useRef, useState } from "react";
import { useLocation, useParams, Link } from "wouter";
import { format } from "date-fns";
import { useQueryClient } from "@tanstack/react-query";
import { useForm, Controller } from "react-hook-form";
import { z } from "zod";
import { zodResolver } from "@hookform/resolvers/zod";
import { Printer, PenTool, CheckCircle, AlertCircle, MessageSquare, ArrowLeft, Edit, Paperclip, Upload, Download, Trash2, FileImage, FileText, Archive, ArchiveRestore } from "lucide-react";
import { 
  useGetQuote, 
  getGetQuoteQueryKey,
  getGetRecentActivityQueryKey, 
  useCreateRevision,
  useUpdateQuote,
  getListQuotesQueryKey,
  useListAttachments,
  getListAttachmentsQueryKey,
  useCreateAttachment,
  useDeleteAttachment,
  getListRevisionsQueryKey,
  useArchiveQuote,
  useUnarchiveQuote
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

const quoteSchema = z.object({
  quoteNumber: z.string().regex(/^[0-9]{7}$/, "Must be exactly 7 digits"),
  customerName: z.string().min(1, "Customer name is required"),
  projectName: z.string().min(1, "Project name is required"),
  jobAddress: z.string().min(1, "Job address is required"),
  categories: z.array(z.enum(["doors", "windows", "trim", "millwork"])).min(1, "Select at least one category"),
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
    door: z.object({
      brand: z.string().optional(),
      seriesStyle: z.string().optional(),
      materialSpecies: z.string().optional(),
      exteriorColor: z.string().optional(),
      interiorFinish: z.string().optional(),
      jambDepth: z.string().optional(),
      hardwareFinish: z.string().optional(),
      glassLiteOptions: z.string().optional(),
    }).optional(),
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
  { id: "doors", label: "Doors" },
  { id: "windows", label: "Windows" },
  { id: "trim", label: "Trim" },
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
  const createRevision = useCreateRevision();
  const updateQuote = useUpdateQuote();
  const archiveQuote = useArchiveQuote();
  const unarchiveQuote = useUnarchiveQuote();

  const [note, setNote] = useState("");
  const [isEditing, setIsEditing] = useState(false);
  const [pendingData, setPendingData] = useState<QuoteFormValues | null>(null);
  const [isArchiveDialogOpen, setIsArchiveDialogOpen] = useState(false);
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

    createRevision.mutate({ id: quoteId, data: { note } }, {
      onSuccess: () => {
        setNote("");
        toast({ title: "Update added", description: "The revision log has been updated." });
        queryClient.invalidateQueries({ queryKey: getGetQuoteQueryKey(quoteId) });
      },
      onError: () => {
        toast({ title: "Error", description: "Failed to add update.", variant: "destructive" });
      }
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

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        <div className="lg:col-span-2 space-y-8">
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
                      <Input 
                        id="jobAddress" 
                        placeholder="e.g. 123 Main St, City, ST 12345" 
                        {...form.register("jobAddress")} 
                      />
                      {form.formState.errors.jobAddress && (
                        <p className="text-sm text-destructive font-medium">{form.formState.errors.jobAddress.message}</p>
                      )}
                    </div>
                  </div>

                  <div className="space-y-4 pt-4 border-t-2 border-border">
                    <Label className="text-lg">Product Categories</Label>
                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                      {CATEGORIES.map(category => (
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
                          <Input 
                            id={`window.${field}`} 
                            {...form.register(`specs.window.${field}` as any)} 
                          />
                        </div>
                      ))}
                    </div>
                  </CardContent>
                </Card>
              )}

              {selectedCategories.includes("doors") && (
                <Card>
                  <CardContent className="p-6 sm:p-8 space-y-6">
                    <h3 className="text-xl font-serif font-bold text-foreground border-b-2 border-border pb-2">Door Specifications</h3>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                      {["brand", "seriesStyle", "materialSpecies", "exteriorColor", "interiorFinish", "jambDepth", "hardwareFinish", "glassLiteOptions"].map((field) => (
                        <div key={field} className="space-y-2">
                          <Label htmlFor={`door.${field}`}>{field.replace(/([A-Z])/g, ' $1').replace(/^./, str => str.toUpperCase())}</Label>
                          <Input 
                            id={`door.${field}`} 
                            {...form.register(`specs.door.${field}` as any)} 
                          />
                        </div>
                      ))}
                    </div>
                  </CardContent>
                </Card>
              )}

              {selectedCategories.includes("trim") && (
                <Card>
                  <CardContent className="p-6 sm:p-8 space-y-4">
                    <h3 className="text-xl font-serif font-bold text-foreground border-b-2 border-border pb-2">Trim Specifications</h3>
                    <div className="space-y-2">
                      <Label htmlFor="trimDescription">Description / Details</Label>
                      <Textarea 
                        id="trimDescription" 
                        {...form.register("specs.trimDescription")} 
                        placeholder="Enter trim profiles, materials, lengths..."
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
                    <h3 className="text-lg font-serif font-bold text-primary bg-primary/5 px-3 py-1 rounded">Trim</h3>
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

        <div className="space-y-8">
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
              <CardTitle className="flex items-center gap-2">
                <MessageSquare className="w-5 h-5" />
                Revision Log
              </CardTitle>
            </CardHeader>
            <CardContent className="pt-0 flex flex-col h-[500px]">
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
                        <div className="space-y-1">
                          <div className="flex items-baseline justify-between gap-2">
                            <span className="font-bold text-foreground text-sm">{rev.authorName}</span>
                            <span className="text-xs text-muted-foreground font-bold shrink-0">{format(new Date(rev.createdAt), "MMM d, h:mm a")}</span>
                          </div>
                          <p className="text-foreground font-medium bg-muted/30 p-3 rounded-md border-2 border-border/50 text-sm whitespace-pre-wrap">
                            {rev.note}
                          </p>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
              
              <form onSubmit={handleAddUpdate} className="mt-auto pt-4 border-t-2 border-border space-y-3">
                <Label htmlFor="note" className="sr-only">Add an update</Label>
                <Textarea 
                  id="note"
                  value={note}
                  onChange={e => setNote(e.target.value)}
                  placeholder="Log a change, conversation, or decision..."
                  className="min-h-[100px] resize-none"
                  disabled={isEditing || quote.archived}
                />
                <Button type="submit" className="w-full" disabled={createRevision.isPending || !note.trim() || isEditing || quote.archived}>
                  {createRevision.isPending ? "Saving..." : "Add Update"}
                </Button>
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