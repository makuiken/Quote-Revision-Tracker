import { useEffect, useRef, useState } from "react";
import { useForm } from "react-hook-form";
import { Redirect } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  FileImage,
  FileText,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  RotateCcw,
  Save,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import {
  useDeleteManufacturerRedactionTemplate,
  getListManufacturerRedactionTemplateOptionsQueryKey,
  getListManufacturerRedactionTemplatesQueryKey,
  useGetCurrentUser,
  useListManufacturerRedactionTemplates,
  useUpdateManufacturerRedactionTemplate,
} from "@workspace/api-client-react";
import { Shell } from "@/components/layout";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/components/ui/toaster";
import {
  TemplateRedactionEditor,
  type TemplateEditorPage,
} from "@/components/template-redaction-editor";
import {
  analyzeTemplateDraft,
  cancelTemplateDraft,
  createTemplateDraftFromTemplate,
  draftPagesToEditorPages,
  getTemplateDraft,
  getTemplateDraftSourcePage,
  patchTemplateDraftRedactions,
  previewTemplateDraftPage,
  requestTemplateDraftUploadUrl,
  saveTemplateDraft,
  type TemplateDraft,
  type TemplateRecord,
} from "@/lib/template-drafts-api";
import {
  metadataValuesForDraft,
  metadataValuesForTemplate,
  type TemplateMetadataValues,
} from "@/lib/admin-template-metadata";

const MAX_SAMPLE_BYTES = 40 * 1024 * 1024;
const PRODUCT_TYPES = [
  "doors",
  "interiorDoors",
  "exteriorDoors",
  "windows",
  "trim",
  "millwork",
] as const;

const PRODUCT_TYPE_LABELS: Record<string, string> = {
  doors: "Doors",
  interiorDoors: "Interior doors",
  exteriorDoors: "Exterior doors",
  windows: "Windows",
  trim: "Trim",
  millwork: "Millwork",
};

type View =
  | { kind: "list" }
  | { kind: "new" }
  | { kind: "edit"; template: TemplateRecord };

type MetadataValues = TemplateMetadataValues;

type PendingTemplateSave = {
  draftId: number;
  expectedRevision: number;
  values: MetadataValues;
  manualRedactions: Record<string, TemplateEditorPage["rects"]>;
};

type PersistedTemplateDraftState = {
  draftId: number | null;
  metadata: MetadataValues;
  pendingSave?: PendingTemplateSave;
};

const TEMPLATE_DRAFT_STORAGE_PREFIX = "quote-tracker:template-draft:";

function templateDraftStorageKey(userId: string) {
  return `${TEMPLATE_DRAFT_STORAGE_PREFIX}${encodeURIComponent(userId)}`;
}

function readPersistedTemplateDraft(
  userId: string,
): PersistedTemplateDraftState | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(templateDraftStorageKey(userId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PersistedTemplateDraftState>;
    if (!parsed || typeof parsed !== "object") return null;
    return {
      draftId: typeof parsed.draftId === "number" ? parsed.draftId : null,
      metadata: {
        name: parsed.metadata?.name ?? "",
        manufacturer: parsed.metadata?.manufacturer ?? "",
        productType: parsed.metadata?.productType ?? "",
        eligibleProductTypes: Array.isArray(
          parsed.metadata?.eligibleProductTypes,
        )
          ? parsed.metadata.eligibleProductTypes.filter(
              (value): value is string => typeof value === "string",
            )
          : [],
        active: parsed.metadata?.active !== false,
      },
      pendingSave:
        parsed.pendingSave &&
        typeof parsed.pendingSave.draftId === "number" &&
        typeof parsed.pendingSave.expectedRevision === "number"
          ? (parsed.pendingSave as PendingTemplateSave)
          : undefined,
    };
  } catch {
    return null;
  }
}

function writePersistedTemplateDraft(
  userId: string,
  patch: Omit<Partial<PersistedTemplateDraftState>, "pendingSave"> & {
    pendingSave?: PendingTemplateSave | null;
  },
) {
  if (typeof window === "undefined") return;
  const current = readPersistedTemplateDraft(userId);
  const next: PersistedTemplateDraftState = {
    draftId: patch.draftId ?? current?.draftId ?? null,
    metadata: patch.metadata ??
      current?.metadata ?? {
        name: "",
        manufacturer: "",
        productType: "",
        eligibleProductTypes: [],
        active: true,
      },
    ...(patch.pendingSave !== undefined
      ? patch.pendingSave
        ? { pendingSave: patch.pendingSave }
        : {}
      : current?.pendingSave
        ? { pendingSave: current.pendingSave }
        : {}),
  };
  window.localStorage.setItem(
    templateDraftStorageKey(userId),
    JSON.stringify(next),
  );
}

function clearPersistedTemplateDraft(userId: string) {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(templateDraftStorageKey(userId));
}

function sameRedactions(
  first: Record<string, TemplateEditorPage["rects"]> | null | undefined,
  second: Record<string, TemplateEditorPage["rects"]> | null | undefined,
) {
  return JSON.stringify(first ?? {}) === JSON.stringify(second ?? {});
}

function pendingSaveMatchesDraft(
  pending: PendingTemplateSave,
  draft: TemplateDraft,
) {
  return (
    draft.id === pending.draftId &&
    draft.revision > pending.expectedRevision &&
    draft.status === "ready" &&
    draft.name === pending.values.name &&
    draft.manufacturer === pending.values.manufacturer &&
    draft.productType === pending.values.eligibleProductTypes[0] &&
    JSON.stringify([...eligibleProductTypes(draft)].sort()) ===
      JSON.stringify([...pending.values.eligibleProductTypes].sort()) &&
    draft.active === pending.values.active &&
    sameRedactions(draft.manualRedactions, pending.manualRedactions)
  );
}

function productTypeLabel(value: string | null | undefined) {
  return value ? (PRODUCT_TYPE_LABELS[value] ?? value) : "Not selected";
}

function errorMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  return "Something went wrong. Try again.";
}

function pageRedactions(pages: TemplateEditorPage[]) {
  return Object.fromEntries(
    pages.map((page) => [String(page.pageNumber), page.rects]),
  );
}

function eligibleProductTypes(
  value:
    | Pick<TemplateRecord, "productType" | "eligibleProductTypes">
    | Pick<TemplateDraft, "productType" | "eligibleProductTypes">,
) {
  const values = value.eligibleProductTypes?.filter(Boolean) ?? [];
  return values.length > 0 &&
    value.productType &&
    !values.includes(value.productType)
    ? [value.productType, ...values]
    : values.length > 0
      ? values
      : value.productType
        ? [value.productType]
        : [];
}

async function uploadPdf(uploadURL: string, file: File) {
  const response = await fetch(uploadURL, {
    method: "PUT",
    headers: { "Content-Type": "application/pdf" },
    body: file,
  });
  if (!response.ok) {
    throw new Error("The PDF upload failed. Check the file and try again.");
  }
}

function TemplatePageMiniMap({
  page,
}: {
  page: TemplateRecord["pages"][number];
}) {
  return (
    <div className="relative h-20 w-14 overflow-hidden rounded border border-border bg-muted/40">
      {page.rects.map((rect, index) => (
        <span
          key={index}
          className="absolute rounded-[1px] border border-slate-800 bg-slate-900/80"
          style={{
            left: `${Math.max(0, Math.min(100, (rect.x / page.width) * 100))}%`,
            top: `${Math.max(0, Math.min(100, (rect.y / page.height) * 100))}%`,
            width: `${Math.max(2, Math.min(100, (rect.width / page.width) * 100))}%`,
            height: `${Math.max(2, Math.min(100, (rect.height / page.height) * 100))}%`,
          }}
        />
      ))}
    </div>
  );
}

function TemplateCard({
  template,
  onEdit,
  onDelete,
  onToggleActive,
  toggling,
}: {
  template: TemplateRecord;
  onEdit: () => void;
  onDelete: () => void;
  onToggleActive: (active: boolean) => void;
  toggling: boolean;
}) {
  return (
    <Card
      className={`flex flex-col border-2 transition-colors ${
        template.active ? "border-primary/20" : "border-border"
      }`}
      data-testid={`card-template-${template.id}`}
    >
      <CardHeader className="border-b border-border bg-muted/20 pb-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <CardTitle className="truncate text-lg">{template.name}</CardTitle>
            <CardDescription className="mt-1 text-xs font-medium">
              {template.manufacturer} ·{" "}
              {eligibleProductTypes(template).map(productTypeLabel).join(", ")}
            </CardDescription>
          </div>
          <span
            className={`flex shrink-0 items-center gap-1 rounded border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider ${
              template.active
                ? "border-green-200 bg-green-100 text-green-800"
                : "border-border bg-muted text-muted-foreground"
            }`}
            data-testid={`status-template-${template.id}`}
          >
            {template.active && <CheckCircle2 className="h-3 w-3" />}
            {template.active ? "Active" : "Inactive"}
          </span>
        </div>
      </CardHeader>
      <CardContent className="flex flex-1 flex-col justify-between gap-4 p-4">
        <div className="space-y-3">
          <div className="flex items-center justify-between text-sm">
            <span className="font-semibold text-muted-foreground">
              Sample pages
            </span>
            <span
              className="font-bold"
              data-testid={`text-template-page-count-${template.id}`}
            >
              {template.pages.length}
            </span>
          </div>
          <div className="flex gap-2 overflow-hidden">
            {template.pages.slice(0, 5).map((page) => (
              <div
                key={page.pageNumber}
                className="flex shrink-0 flex-col items-center gap-1"
              >
                <TemplatePageMiniMap page={page} />
                <span className="text-[10px] font-bold text-muted-foreground">
                  Page {page.pageNumber}
                </span>
              </div>
            ))}
            {template.pages.length > 5 && (
              <div className="flex h-20 w-14 shrink-0 items-center justify-center rounded border border-dashed border-border text-xs font-bold text-muted-foreground">
                +{template.pages.length - 5}
              </div>
            )}
          </div>
          {!template.sourceAvailable && (
            <div
              className="flex gap-2 rounded-md border border-amber-200 bg-amber-50 p-2 text-xs font-medium text-amber-900"
              data-testid={`status-template-source-missing-${template.id}`}
            >
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              Legacy sample unavailable. Replace the sample to inspect its
              pages.
            </div>
          )}
        </div>
        <div className="flex items-center justify-between border-t border-border pt-3">
          <label className="flex cursor-pointer items-center gap-2 text-sm font-bold">
            <Checkbox
              checked={template.active}
              disabled={toggling}
              data-testid={`checkbox-template-active-${template.id}`}
              onCheckedChange={(checked) => onToggleActive(Boolean(checked))}
            />
            Auto-apply
          </label>
          <div className="flex items-center gap-1">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="font-bold"
              data-testid={`button-edit-template-${template.id}`}
              onClick={onEdit}
            >
              <Pencil className="mr-1.5 h-3.5 w-3.5" />
              Edit
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="font-bold text-destructive hover:bg-destructive/10 hover:text-destructive"
              data-testid={`button-delete-template-${template.id}`}
              onClick={onDelete}
            >
              <Trash2 className="mr-1.5 h-3.5 w-3.5" />
              Delete
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

export default function AdminTemplatesPage() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { data: dbUser, isLoading: isUserLoading } = useGetCurrentUser();
  const templatesQuery = useListManufacturerRedactionTemplates({
    query: {
      enabled: dbUser?.role === "admin",
      queryKey: getListManufacturerRedactionTemplatesQueryKey(),
      refetchOnMount: "always",
      staleTime: 0,
    },
  });
  const updateTemplate = useUpdateManufacturerRedactionTemplate();
  const deleteTemplate = useDeleteManufacturerRedactionTemplate();
  const templates = (templatesQuery.data ?? []) as unknown as TemplateRecord[];

  const [view, setView] = useState<View>({ kind: "list" });
  const [deleteId, setDeleteId] = useState<number | null>(null);
  const [replaceDialogOpen, setReplaceDialogOpen] = useState(false);
  const [replacementFile, setReplacementFile] = useState<File | null>(null);
  const [draft, setDraft] = useState<TemplateDraft | null>(null);
  const [editorPages, setEditorPages] = useState<TemplateEditorPage[]>([]);
  const editorPagesRef = useRef<TemplateEditorPage[]>([]);
  const [sourceUrls, setSourceUrls] = useState<Record<number, string | null>>(
    {},
  );
  const [cleanedUrls, setCleanedUrls] = useState<Record<number, string | null>>(
    {},
  );
  const [editorMode, setEditorMode] = useState<"source" | "cleaned">("source");
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [pageError, setPageError] = useState<string | null>(null);
  const [sourceRetryNonce, setSourceRetryNonce] = useState(0);
  const [activeToggleId, setActiveToggleId] = useState<number | null>(null);
  const [draftWarning, setDraftWarning] = useState<string | null>(null);
  const [metadataPersistenceReady, setMetadataPersistenceReady] =
    useState(false);
  const sampleInputRef = useRef<HTMLInputElement>(null);
  const replacementInputRef = useRef<HTMLInputElement>(null);
  const hydratedDraftIdRef = useRef<number | null>(null);
  const editorDraftSignatureRef = useRef<string | null>(null);
  const resumeAttemptedRef = useRef(false);
  const resumeInProgressRef = useRef(false);
  const resumeHydrationDraftIdRef = useRef<number | null>(null);
  const actionInFlightRef = useRef<string | null>(null);
  const sourceUrlsRef = useRef<Record<number, string | null>>({});
  const cleanedUrlsRef = useRef<Record<number, string | null>>({});
  const metadataForm = useForm<MetadataValues>({
    defaultValues: {
      name: "",
      manufacturer: "",
      productType: "",
      eligibleProductTypes: [],
      active: true,
    },
  });
  const watchedManufacturer = metadataForm.watch("manufacturer");
  const watchedProductTypes = metadataForm.watch("eligibleProductTypes");
  const watchedMetadata = metadataForm.watch();

  const selectedTemplate = view.kind === "edit" ? view.template : null;
  const isEditing = view.kind === "edit";
  const sourcePreviewReady =
    Boolean(draft?.sourceAvailable) &&
    editorPages.length > 0 &&
    editorPages.every((page) => Boolean(page.sourceUrl));

  useEffect(() => {
    editorPagesRef.current = editorPages;
  }, [editorPages]);

  useEffect(() => {
    sourceUrlsRef.current = sourceUrls;
  }, [sourceUrls]);

  useEffect(() => {
    cleanedUrlsRef.current = cleanedUrls;
  }, [cleanedUrls]);

  useEffect(() => {
    if (
      !dbUser?.id ||
      view.kind === "list" ||
      !metadataPersistenceReady ||
      (view.kind === "edit" && !draft) ||
      resumeInProgressRef.current
    ) {
      return;
    }
    writePersistedTemplateDraft(dbUser.id, {
      draftId: draft?.id ?? null,
      metadata: {
        name: watchedMetadata.name ?? "",
        manufacturer: watchedMetadata.manufacturer ?? "",
        productType: watchedMetadata.productType ?? "",
        eligibleProductTypes: watchedMetadata.eligibleProductTypes ?? [],
        active: watchedMetadata.active !== false,
      },
    });
  }, [
    dbUser?.id,
    draft?.id,
    view.kind,
    metadataPersistenceReady,
    draft,
    watchedMetadata.name,
    watchedMetadata.manufacturer,
    watchedMetadata.productType,
    watchedMetadata.eligibleProductTypes,
    watchedMetadata.active,
  ]);

  useEffect(() => {
    if (!dbUser?.id || !draft || !metadataPersistenceReady) return;
    const persisted = readPersistedTemplateDraft(dbUser.id);
    const pendingSave =
      persisted?.pendingSave?.draftId === draft.id
        ? persisted.pendingSave
        : undefined;
    writePersistedTemplateDraft(dbUser.id, {
      draftId: draft.id,
      pendingSave: pendingSave ?? null,
    });
  }, [dbUser?.id, draft?.id, metadataPersistenceReady]);

  useEffect(() => {
    return () => {
      Object.values(sourceUrlsRef.current).forEach(
        (url) => url && URL.revokeObjectURL(url),
      );
      Object.values(cleanedUrlsRef.current).forEach(
        (url) => url && URL.revokeObjectURL(url),
      );
    };
  }, []);

  useEffect(() => {
    if (!draft) {
      hydratedDraftIdRef.current = null;
      editorDraftSignatureRef.current = null;
      return;
    }
    const editorDraftSignature = `${draft.id}:${draft.revision}:${draft.analysis?.length ?? 0}`;
    if (editorDraftSignatureRef.current !== editorDraftSignature) {
      editorDraftSignatureRef.current = editorDraftSignature;
      const previousPages = new Map(
        editorPagesRef.current.map((page) => [page.pageNumber, page]),
      );
      setEditorPages(
        draftPagesToEditorPages(
          draft,
          sourceUrlsRef.current,
          cleanedUrlsRef.current,
        ).map((page) => {
          const previous = previousPages.get(page.pageNumber);
          return {
            ...page,
            sourceLoading: previous?.sourceLoading ?? false,
            sourceError: previous?.sourceError ?? null,
          };
        }),
      );
      Object.values(cleanedUrlsRef.current).forEach(
        (url) => url && URL.revokeObjectURL(url),
      );
      setCleanedUrls({});
      setEditorMode("source");
    }
    // Redaction PATCH/analysis responses replace the draft object but must not
    // overwrite metadata text the administrator has already entered.
    if (hydratedDraftIdRef.current !== draft.id) {
      hydratedDraftIdRef.current = draft.id;
      const persistedState = dbUser?.id
        ? readPersistedTemplateDraft(dbUser.id)
        : null;
      metadataForm.reset(
        metadataValuesForDraft({
          draft,
          selectedTemplate,
          persistedMetadata:
            persistedState?.draftId === draft.id
              ? persistedState.metadata
              : null,
          persistedDraftId: persistedState?.draftId,
        }),
      );
      setMetadataPersistenceReady(true);
    }
  }, [dbUser?.id, draft, selectedTemplate, metadataForm]);

  useEffect(() => {
    if (
      resumeHydrationDraftIdRef.current !== null &&
      draft?.id === resumeHydrationDraftIdRef.current
    ) {
      // Let the draft effect above reset the form first. The next render may
      // persist the restored values; never expose the default form state to
      // the persistence effect during that handoff.
      resumeHydrationDraftIdRef.current = null;
      resumeInProgressRef.current = false;
    }
  }, [draft?.id]);

  useEffect(() => {
    if (!draft?.analysis?.length || !draft.sourceAvailable) {
      Object.values(sourceUrlsRef.current).forEach(
        (url) => url && URL.revokeObjectURL(url),
      );
      setSourceUrls({});
      setEditorPages((pages) =>
        pages.map((page) => ({
          ...page,
          sourceUrl: null,
          sourceLoading: false,
          sourceError: draft?.sourceAvailable
            ? "The source preview is not available yet."
            : null,
        })),
      );
      return;
    }
    let disposed = false;
    Object.values(sourceUrlsRef.current).forEach(
      (url) => url && URL.revokeObjectURL(url),
    );
    setSourceUrls({});
    setEditorPages((pages) =>
      pages.map((page) => ({
        ...page,
        sourceUrl: null,
        sourceLoading: true,
        sourceError: null,
      })),
    );
    const loadPages = async () => {
      const results = await Promise.all(
        draft.analysis!.map(async (page) => {
          try {
            const blob = await getTemplateDraftSourcePage(
              draft.id,
              page.pageNumber,
            );
            return {
              pageNumber: page.pageNumber,
              url: URL.createObjectURL(blob),
              error: null,
            };
          } catch (error) {
            return {
              pageNumber: page.pageNumber,
              url: null,
              error:
                error instanceof Error
                  ? `Source preview failed to load: ${error.message}`
                  : "Source preview failed to load. Retry.",
            };
          }
        }),
      );
      if (disposed) {
        results.forEach(
          (result) => result.url && URL.revokeObjectURL(result.url),
        );
        return;
      }
      Object.values(sourceUrlsRef.current).forEach(
        (url) => url && URL.revokeObjectURL(url),
      );
      setSourceUrls(
        Object.fromEntries(
          results.map((result) => [result.pageNumber, result.url]),
        ),
      );
      setEditorPages((pages) =>
        pages.map((page) => {
          const result = results.find(
            (candidate) => candidate.pageNumber === page.pageNumber,
          );
          return {
            ...page,
            sourceLoading: false,
            sourceError:
              result?.error ?? "Source preview failed to load. Retry.",
          };
        }),
      );
    };
    void loadPages();
    return () => {
      disposed = true;
    };
  }, [
    draft?.id,
    draft?.sourceAvailable,
    draft?.source?.sha256,
    draft?.analysis?.length,
    sourceRetryNonce,
  ]);

  useEffect(() => {
    if (
      Object.keys(sourceUrls).length === 0 &&
      Object.keys(cleanedUrls).length === 0
    )
      return;
    setEditorPages((pages) =>
      pages.map((page) => ({
        ...page,
        sourceUrl: sourceUrls[page.pageNumber] ?? null,
        cleanedUrl: cleanedUrls[page.pageNumber] ?? null,
      })),
    );
  }, [sourceUrls, cleanedUrls]);

  useEffect(() => {
    if (
      !dbUser?.id ||
      dbUser.role !== "admin" ||
      !templatesQuery.isSuccess ||
      resumeAttemptedRef.current
    ) {
      return;
    }
    resumeAttemptedRef.current = true;
    const persisted = readPersistedTemplateDraft(dbUser.id);
    if (!persisted?.draftId) return;

    resumeInProgressRef.current = true;
    setBusyAction("resume");
    void (async () => {
      try {
        let hydrated = await getTemplateDraft(persisted.draftId!);
        // Analysis can continue on the server while the browser is gone.
        // Reconcile its final state rather than creating a second draft.
        for (
          let attempt = 0;
          hydrated.status === "analyzing" && attempt < 30;
          attempt += 1
        ) {
          await new Promise((resolve) => window.setTimeout(resolve, 1000));
          hydrated = await getTemplateDraft(persisted.draftId!);
        }
        if (hydrated.status === "cancelled") {
          clearPersistedTemplateDraft(dbUser.id);
          return;
        }
        if (
          persisted.pendingSave &&
          pendingSaveMatchesDraft(persisted.pendingSave, hydrated)
        ) {
          clearPersistedTemplateDraft(dbUser.id);
          invalidateTemplateCaches();
          toast({
            title: "Template save recovered",
            description:
              "The previous save completed before the connection was lost.",
          });
          return;
        }
        const template = hydrated.templateId
          ? templates.find((candidate) => candidate.id === hydrated.templateId)
          : null;
        if (hydrated.templateId && !template) {
          throw new Error(
            "The saved template for this draft no longer exists. Cancel this draft and start again.",
          );
        }
        setView(template ? { kind: "edit", template } : { kind: "new" });
        resumeHydrationDraftIdRef.current = hydrated.id;
        setDraft(hydrated);
        toast({
          title: "Template draft resumed",
          description:
            "Your last saved metadata and redaction work were restored.",
        });
      } catch (error) {
        setPageError(
          `Could not resume the template draft: ${errorMessage(error)}`,
        );
        toast({
          title: "Template draft could not be resumed",
          description: errorMessage(error),
          variant: "destructive",
        });
      } finally {
        if (resumeHydrationDraftIdRef.current === null) {
          resumeInProgressRef.current = false;
        }
        setBusyAction(null);
      }
    })();
  }, [dbUser?.id, dbUser?.role, templatesQuery.isSuccess, templates, toast]);

  const invalidateTemplateCaches = () => {
    void queryClient.invalidateQueries({
      queryKey: getListManufacturerRedactionTemplatesQueryKey(),
    });
    void queryClient.invalidateQueries({
      queryKey: getListManufacturerRedactionTemplateOptionsQueryKey(),
    });
  };

  const resetWorkspace = () => {
    if (dbUser?.id) clearPersistedTemplateDraft(dbUser.id);
    setMetadataPersistenceReady(false);
    Object.values(sourceUrlsRef.current).forEach(
      (url) => url && URL.revokeObjectURL(url),
    );
    Object.values(cleanedUrlsRef.current).forEach(
      (url) => url && URL.revokeObjectURL(url),
    );
    setView({ kind: "list" });
    setDraft(null);
    setEditorPages([]);
    setSourceUrls({});
    setCleanedUrls({});
    setPageError(null);
    setDraftWarning(null);
    setReplacementFile(null);
    metadataForm.reset({
      name: "",
      manufacturer: "",
      productType: "",
      eligibleProductTypes: [],
      active: true,
    });
  };

  const openNew = () => {
    resetWorkspace();
    setMetadataPersistenceReady(true);
    setView({ kind: "new" });
  };

  const openEdit = async (template: TemplateRecord) => {
    setMetadataPersistenceReady(false);
    metadataForm.reset(metadataValuesForTemplate(template));
    hydratedDraftIdRef.current = null;
    editorDraftSignatureRef.current = null;
    setDraft(null);
    setView({ kind: "edit", template });
    setPageError(null);
    setBusyAction("open");
    try {
      const response = await createTemplateDraftFromTemplate(template.id);
      if (!("draft" in response))
        throw new Error("The server did not return an edit draft.");
      setDraft(response.draft);
    } catch (error) {
      setPageError(errorMessage(error));
      toast({
        title: "Could not open template",
        description: errorMessage(error),
        variant: "destructive",
      });
    } finally {
      setBusyAction(null);
    }
  };

  const validateSample = (file: File | null) => {
    if (!file) return "Choose a PDF sample first.";
    if (
      file.type !== "application/pdf" &&
      !file.name.toLowerCase().endsWith(".pdf")
    ) {
      return "The sample must be a PDF file.";
    }
    if (file.size > MAX_SAMPLE_BYTES) {
      return "The sample PDF must be 40 MB or smaller.";
    }
    if (file.size === 0) return "The sample PDF is empty.";
    return null;
  };

  const uploadAndAnalyze = async (
    file: File,
    uploadInput: {
      manufacturer?: string;
      productType?: string;
      eligibleProductTypes?: string[];
    },
  ) => {
    const validationError = validateSample(file);
    if (validationError) throw new Error(validationError);
    const requested = await requestTemplateDraftUploadUrl({
      name: file.name,
      size: file.size,
      contentType: "application/pdf",
      ...uploadInput,
    });
    setDraft(requested.draft);
    await uploadPdf(requested.uploadURL, file);
    const analyzed = await analyzeTemplateDraft(requested.draft.id, {
      manufacturer: uploadInput.manufacturer,
    });
    setDraft(analyzed);
    return analyzed;
  };

  const handleNewSample = async (file: File | null) => {
    if (!file) return;
    if (actionInFlightRef.current) return;
    actionInFlightRef.current = "upload";
    const previousDraftId = draft?.id;
    setPageError(null);
    setBusyAction("upload");
    try {
      const analyzed = await uploadAndAnalyze(file, {
        manufacturer: watchedManufacturer.trim() || undefined,
        productType: watchedProductTypes[0] || undefined,
        eligibleProductTypes: watchedProductTypes,
      });
      if (previousDraftId && previousDraftId !== analyzed.id) {
        await cancelTemplateDraft(previousDraftId).catch(() => undefined);
      }
      toast({
        title: "Sample analyzed",
        description:
          "Review the pages and redaction boxes before saving the template.",
      });
    } catch (error) {
      setPageError(errorMessage(error));
      toast({
        title: "Sample processing failed",
        description: errorMessage(error),
        variant: "destructive",
      });
    } finally {
      actionInFlightRef.current = null;
      setBusyAction(null);
      if (sampleInputRef.current) sampleInputRef.current.value = "";
    }
  };

  const handleReplaceSample = async () => {
    if (!selectedTemplate || !replacementFile) return;
    if (actionInFlightRef.current) return;
    const validationError = validateSample(replacementFile);
    if (validationError) {
      setPageError(validationError);
      return;
    }
    setPageError(null);
    setReplaceDialogOpen(false);
    actionInFlightRef.current = "replace";
    setBusyAction("replace");
    try {
      const response = await createTemplateDraftFromTemplate(
        selectedTemplate.id,
        {
          replaceSample: true,
          name: replacementFile.name,
          size: replacementFile.size,
          contentType: "application/pdf",
          manufacturer: metadataForm.getValues("manufacturer").trim(),
          productType:
            metadataForm.getValues("eligibleProductTypes")[0] ||
            selectedTemplate.productType,
          eligibleProductTypes: metadataForm.getValues("eligibleProductTypes"),
        },
      );
      if (!("draft" in response))
        throw new Error("The server did not return a replacement draft.");
      const replacementDraft = response.draft;
      if (draft && draft.id !== replacementDraft.id) {
        await cancelTemplateDraft(draft.id).catch(() => undefined);
      }
      setDraft(replacementDraft);
      if ("uploadURL" in response) {
        await uploadPdf(response.uploadURL, replacementFile);
      }
      const analyzed = await analyzeTemplateDraft(replacementDraft.id, {
        manufacturer: metadataForm.getValues("manufacturer").trim(),
      });
      setDraft(analyzed);
      setDraftWarning(null);
      toast({
        title: "Replacement sample analyzed",
        description:
          "The saved template is unchanged until you save this draft.",
      });
    } catch (error) {
      setPageError(errorMessage(error));
      toast({
        title: "Could not replace sample",
        description: errorMessage(error),
        variant: "destructive",
      });
    } finally {
      actionInFlightRef.current = null;
      setBusyAction(null);
      setReplacementFile(null);
      if (replacementInputRef.current) replacementInputRef.current.value = "";
    }
  };

  const persistRedactions = async () => {
    if (!draft) throw new Error("Upload and analyze a sample before saving.");
    const updated = await patchTemplateDraftRedactions(
      draft.id,
      pageRedactions(editorPages),
    );
    setDraft(updated);
    return updated;
  };

  const handlePreview = async () => {
    if (
      !draft ||
      editorPages.length === 0 ||
      !sourcePreviewReady ||
      actionInFlightRef.current
    )
      return;
    actionInFlightRef.current = "preview";
    setPageError(null);
    setBusyAction("preview");
    try {
      const updated = await persistRedactions();
      const redactions = pageRedactions(editorPages);
      const results = await Promise.all(
        (updated.analysis ?? []).map(async (page) => {
          const blob = await previewTemplateDraftPage(
            updated.id,
            page.pageNumber,
            redactions,
          );
          return [page.pageNumber, URL.createObjectURL(blob)] as const;
        }),
      );
      Object.values(cleanedUrlsRef.current).forEach(
        (url) => url && URL.revokeObjectURL(url),
      );
      setCleanedUrls(Object.fromEntries(results));
      setEditorMode("cleaned");
      toast({
        title: "Cleaned preview ready",
        description: "Review every page before saving the template.",
      });
    } catch (error) {
      setPageError(errorMessage(error));
      toast({
        title: "Could not generate preview",
        description: errorMessage(error),
        variant: "destructive",
      });
    } finally {
      actionInFlightRef.current = null;
      setBusyAction(null);
    }
  };

  const onSave = metadataForm.handleSubmit(async (values) => {
    if (actionInFlightRef.current) return;
    if (!draft) {
      setPageError("Upload and analyze a sample before saving.");
      return;
    }
    if (
      !values.name.trim() ||
      !values.manufacturer.trim() ||
      values.eligibleProductTypes.length === 0
    ) {
      setPageError(
        "Name, manufacturer, and at least one eligible product type are required.",
      );
      return;
    }
    setPageError(null);
    actionInFlightRef.current = "save";
    setBusyAction("save");
    try {
      const updatedDraft = await persistRedactions();
      const saveInput = {
        name: values.name.trim(),
        manufacturer: values.manufacturer.trim(),
        productType: values.eligibleProductTypes[0]!,
        eligibleProductTypes: values.eligibleProductTypes,
        active: values.active,
        ...(selectedTemplate
          ? { expectedTemplateUpdatedAt: selectedTemplate.updatedAt }
          : {}),
        expectedDraftRevision: updatedDraft.revision,
        manualRedactions: pageRedactions(editorPages),
      };
      if (dbUser?.id) {
        writePersistedTemplateDraft(dbUser.id, {
          draftId: updatedDraft.id,
          metadata: values,
          pendingSave: {
            draftId: updatedDraft.id,
            expectedRevision: updatedDraft.revision,
            values,
            manualRedactions: saveInput.manualRedactions,
          },
        });
      }
      await saveTemplateDraft(updatedDraft.id, saveInput);
      if (dbUser?.id) clearPersistedTemplateDraft(dbUser.id);
      invalidateTemplateCaches();
      toast({
        title: selectedTemplate ? "Template updated" : "Template saved",
        description: `${values.name.trim()} is now ${values.active ? "active" : "inactive"} for future uploads.`,
      });
      resetWorkspace();
    } catch (error) {
      setPageError(errorMessage(error));
      toast({
        title: "Template was not saved",
        description: errorMessage(error),
        variant: "destructive",
      });
    } finally {
      actionInFlightRef.current = null;
      setBusyAction(null);
    }
  });

  const onCancel = async () => {
    if (busyAction || actionInFlightRef.current) return;
    if (!draft) {
      resetWorkspace();
      return;
    }
    actionInFlightRef.current = "cancel";
    setBusyAction("cancel");
    try {
      await cancelTemplateDraft(draft.id);
      resetWorkspace();
    } catch (error) {
      setPageError(errorMessage(error));
      toast({
        title: "Could not cancel draft",
        description: errorMessage(error),
        variant: "destructive",
      });
    } finally {
      actionInFlightRef.current = null;
      setBusyAction(null);
    }
  };

  const handleDelete = async () => {
    if (deleteId === null) return;
    setBusyAction(`delete-${deleteId}`);
    try {
      await deleteTemplate.mutateAsync({ id: deleteId });
      invalidateTemplateCaches();
      setDeleteId(null);
      toast({
        title: "Template deleted",
        description:
          "Future uploads will require manual review until another template is active.",
      });
    } catch (error) {
      toast({
        title: "Could not delete template",
        description: errorMessage(error),
        variant: "destructive",
      });
    } finally {
      setBusyAction(null);
    }
  };

  const handleToggleActive = async (
    template: TemplateRecord,
    active: boolean,
  ) => {
    setActiveToggleId(template.id);
    try {
      await updateTemplate.mutateAsync({
        id: template.id,
        data: { active },
      });
      invalidateTemplateCaches();
      toast({
        title: active ? "Template activated" : "Template deactivated",
        description: "Manufacturer choices were refreshed for future uploads.",
      });
    } catch (error) {
      toast({
        title: "Could not change template status",
        description: errorMessage(error),
        variant: "destructive",
      });
    } finally {
      setActiveToggleId(null);
    }
  };

  if (!isUserLoading && dbUser?.role !== "admin") {
    return <Redirect to="/quotes" />;
  }

  if (isUserLoading) {
    return (
      <Shell>
        <div
          className="flex min-h-[320px] items-center justify-center text-muted-foreground"
          data-testid="status-admin-templates-loading"
        >
          <Loader2 className="mr-2 h-5 w-5 animate-spin" />
          Loading template administration…
        </div>
      </Shell>
    );
  }

  if (view.kind === "list") {
    return (
      <Shell>
        <div className="mb-8 flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
          <div>
            <p className="mb-2 text-xs font-bold uppercase tracking-[0.2em] text-primary">
              Admin workspace
            </p>
            <h1 className="text-3xl font-extrabold tracking-tight text-foreground">
              Manufacturer templates
            </h1>
            <p className="mt-1 max-w-2xl font-medium text-muted-foreground">
              Prepare reusable redaction rules independently of customer quotes.
              Originals remain private and template edits affect future uploads
              only.
            </p>
          </div>
          <Button
            type="button"
            className="font-bold shadow-sm"
            disabled={busyAction !== null}
            data-testid="button-new-template"
            onClick={openNew}
          >
            <Plus className="mr-2 h-4 w-4" />
            New template
          </Button>
        </div>

        {templatesQuery.isError ? (
          <Card
            className="border-destructive/30 bg-destructive/5"
            data-testid="status-templates-error"
          >
            <CardContent className="flex flex-col items-center justify-center p-10 text-center">
              <AlertTriangle className="mb-3 h-9 w-9 text-destructive" />
              <h2 className="font-bold">Templates could not be loaded</h2>
              <p className="mt-1 max-w-md text-sm text-muted-foreground">
                {errorMessage(templatesQuery.error)}
              </p>
              <Button
                type="button"
                variant="outline"
                className="mt-5 font-bold"
                data-testid="button-retry-templates"
                onClick={() => void templatesQuery.refetch()}
              >
                <RefreshCw className="mr-2 h-4 w-4" />
                Retry
              </Button>
            </CardContent>
          </Card>
        ) : templatesQuery.isLoading ? (
          <div
            className="flex min-h-[280px] items-center justify-center text-muted-foreground"
            data-testid="status-templates-loading"
          >
            <Loader2 className="mr-2 h-5 w-5 animate-spin" />
            Loading templates…
          </div>
        ) : templates.length === 0 ? (
          <Card
            className="border-dashed bg-muted/30"
            data-testid="status-templates-empty"
          >
            <CardContent className="flex flex-col items-center justify-center p-14 text-center">
              <FileText className="mb-4 h-12 w-12 text-muted-foreground/30" />
              <h2 className="text-lg font-bold">No templates yet</h2>
              <p className="mt-2 max-w-md text-sm text-muted-foreground">
                Upload an independent manufacturer sample to create your first
                active or inactive template.
              </p>
              <Button
                type="button"
                className="mt-5 font-bold"
                data-testid="button-create-first-template"
                onClick={openNew}
              >
                <Upload className="mr-2 h-4 w-4" />
                Upload first sample
              </Button>
            </CardContent>
          </Card>
        ) : (
          <div
            className="grid grid-cols-1 gap-5 md:grid-cols-2 xl:grid-cols-3"
            data-testid="grid-templates"
          >
            {templates.map((template) => (
              <TemplateCard
                key={template.id}
                template={template}
                onEdit={() => void openEdit(template)}
                onDelete={() => setDeleteId(template.id)}
                onToggleActive={(active) =>
                  void handleToggleActive(template, active)
                }
                toggling={activeToggleId === template.id}
              />
            ))}
          </div>
        )}

        <Dialog
          open={deleteId !== null}
          onOpenChange={(open) => !open && setDeleteId(null)}
        >
          <DialogContent>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2 text-destructive">
                <AlertTriangle className="h-5 w-5" />
                Delete template?
              </DialogTitle>
              <DialogDescription>
                This removes the reusable template for future uploads. Existing
                cleaned pages, signed snapshots, and historical samples are not
                changed.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                className="font-bold"
                data-testid="button-cancel-delete-template"
                onClick={() => setDeleteId(null)}
              >
                Cancel
              </Button>
              <Button
                type="button"
                variant="destructive"
                className="font-bold"
                data-testid="button-confirm-delete-template"
                disabled={busyAction?.startsWith("delete-")}
                onClick={() => void handleDelete()}
              >
                {busyAction?.startsWith("delete-") && (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                )}
                Delete template
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </Shell>
    );
  }

  const workspaceTitle = isEditing ? "Edit template" : "New template";
  const workspaceDescription = isEditing
    ? "Update metadata or redactions in a private draft. The saved template changes only after an atomic save."
    : "Upload a representative manufacturer PDF, mark private details, and save the reusable rules.";

  return (
    <Shell>
      <div className="mb-6">
        <Button
          type="button"
          variant="ghost"
          className="-ml-2 mb-2 font-bold text-muted-foreground"
          disabled={busyAction !== null}
          data-testid="button-back-templates"
          onClick={() => void onCancel()}
        >
          <ArrowLeft className="mr-1.5 h-4 w-4" />
          Back to templates
        </Button>
        <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-end">
          <div>
            <p className="mb-2 text-xs font-bold uppercase tracking-[0.2em] text-primary">
              Private authoring
            </p>
            <h1 className="text-3xl font-extrabold tracking-tight">
              {workspaceTitle}
            </h1>
            <p className="mt-1 font-medium text-muted-foreground">
              {workspaceDescription}
            </p>
          </div>
          {isEditing && selectedTemplate && (
            <span
              className="rounded-full border border-border bg-muted px-3 py-1 text-xs font-bold text-muted-foreground"
              data-testid="text-editing-template"
            >
              Editing {selectedTemplate.name}
            </span>
          )}
        </div>
      </div>

      {pageError && (
        <div
          className="mb-5 flex items-start gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive"
          role="alert"
          data-testid="status-template-error"
        >
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <div className="flex-1 font-medium">{pageError}</div>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-7 w-7 text-destructive"
            aria-label="Dismiss error"
            data-testid="button-dismiss-template-error"
            onClick={() => setPageError(null)}
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
      )}

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[320px_minmax(0,1fr)]">
        <div className="space-y-5">
          <Card className="border-border shadow-sm">
            <CardHeader className="border-b border-border bg-muted/20 pb-4">
              <CardTitle className="text-base">Template details</CardTitle>
              <CardDescription>
                Name, manufacturer, and product type are used when this is
                matched to a future upload.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4 pt-5">
              <div className="space-y-1.5">
                <Label htmlFor="template-name">Template name</Label>
                <Input
                  id="template-name"
                  placeholder="Marvin windows cleanup"
                  className="font-medium"
                  data-testid="input-template-name"
                  {...metadataForm.register("name")}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="template-manufacturer">Manufacturer</Label>
                <Input
                  id="template-manufacturer"
                  placeholder="Marvin"
                  className="font-medium"
                  data-testid="input-template-manufacturer"
                  {...metadataForm.register("manufacturer")}
                />
                <p className="text-[11px] text-muted-foreground">
                  Matching ignores case and repeated whitespace.
                </p>
              </div>
              <div className="space-y-2">
                <Label>Eligible product types</Label>
                <div
                  className="grid grid-cols-2 gap-2 rounded-md border border-border p-3"
                  data-testid="group-template-product-types"
                >
                  {PRODUCT_TYPES.map((type) => {
                    const checked = watchedProductTypes.includes(type);
                    return (
                      <label
                        key={type}
                        className="flex cursor-pointer items-center gap-2 text-sm font-medium"
                      >
                        <Checkbox
                          checked={checked}
                          onCheckedChange={(nextChecked) => {
                            const next = nextChecked
                              ? [...watchedProductTypes, type]
                              : watchedProductTypes.filter(
                                  (value) => value !== type,
                                );
                            metadataForm.setValue(
                              "eligibleProductTypes",
                              next,
                              {
                                shouldDirty: true,
                              },
                            );
                            metadataForm.setValue(
                              "productType",
                              next[0] ?? "",
                              { shouldDirty: true },
                            );
                          }}
                          data-testid={`checkbox-template-product-type-${type}`}
                        />
                        {productTypeLabel(type)}
                      </label>
                    );
                  })}
                </div>
                <p className="text-[11px] text-muted-foreground">
                  Select every category this template can safely redact,
                  including both interior and exterior doors when applicable.
                </p>
              </div>
              <label className="flex cursor-pointer items-start gap-3 rounded-md border border-border p-3">
                <Checkbox
                  checked={metadataForm.watch("active")}
                  onCheckedChange={(checked) =>
                    metadataForm.setValue("active", Boolean(checked), {
                      shouldDirty: true,
                    })
                  }
                  data-testid="checkbox-template-active"
                />
                <span>
                  <span className="block text-sm font-bold">
                    Active template
                  </span>
                  <span className="mt-0.5 block text-xs text-muted-foreground">
                    Active templates appear in manufacturer upload choices.
                  </span>
                </span>
              </label>
            </CardContent>
          </Card>

          {!draft || draft.status === "awaiting_upload" ? (
            <Card className="border-dashed border-primary/40 bg-primary/[0.03]">
              <CardHeader className="pb-3">
                <CardTitle className="text-base">
                  {draft ? "Resume sample upload" : "Upload sample PDF"}
                </CardTitle>
                <CardDescription>
                  {draft
                    ? "The previous upload did not finish. Choose the PDF again to continue this draft safely."
                    : "Use a real manufacturer sample. It is stored privately and never exposed to salespeople."}
                </CardDescription>
              </CardHeader>
              <CardContent>
                <input
                  ref={sampleInputRef}
                  type="file"
                  accept="application/pdf,.pdf"
                  className="hidden"
                  data-testid="input-template-sample-file"
                  onChange={(event) =>
                    void handleNewSample(event.target.files?.[0] ?? null)
                  }
                />
                <Button
                  type="button"
                  className="w-full font-bold"
                  disabled={busyAction !== null}
                  data-testid="button-upload-template-sample"
                  onClick={() => sampleInputRef.current?.click()}
                >
                  {busyAction === "upload" ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : (
                    <Upload className="mr-2 h-4 w-4" />
                  )}
                  {busyAction === "upload"
                    ? "Uploading and analyzing…"
                    : draft
                      ? "Choose sample PDF again"
                      : "Choose sample PDF"}
                </Button>
                <p className="mt-2 text-center text-[11px] text-muted-foreground">
                  PDF only · maximum 40 MB
                </p>
              </CardContent>
            </Card>
          ) : (
            <>
              {(!draft.sourceAvailable || draftWarning) && (
                <div
                  className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-950"
                  data-testid="status-template-source-warning"
                >
                  <div className="flex items-start gap-2">
                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                    <div>
                      <p className="font-bold">
                        {draft.sourceAvailable
                          ? "Review needed"
                          : "Original sample is unavailable"}
                      </p>
                      <p className="mt-1">
                        {draft.sourceAvailable
                          ? draftWarning
                          : "This legacy template has no retained source sample, so its original page preview cannot be shown. Metadata edits remain available; replace the sample to edit with a visual preview."}
                      </p>
                    </div>
                  </div>
                </div>
              )}
              <Card className="border-border shadow-sm">
                <CardHeader className="border-b border-border bg-muted/20 pb-3">
                  <CardTitle className="text-base">Sample source</CardTitle>
                  <CardDescription>
                    {draft.source?.originalName ??
                      draft.originalName ??
                      "Source metadata unavailable"}
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-3 pt-4">
                  <Button
                    type="button"
                    variant="outline"
                    className="w-full font-bold"
                    disabled={busyAction !== null}
                    data-testid="button-replace-template-sample"
                    onClick={() => setReplaceDialogOpen(true)}
                  >
                    <RotateCcw className="mr-2 h-4 w-4" />
                    Replace sample
                  </Button>
                  <p className="text-[11px] leading-relaxed text-muted-foreground">
                    Replacing creates a new private draft. The current saved
                    sample and template remain unchanged until you save.
                  </p>
                </CardContent>
              </Card>
            </>
          )}

          {draft?.warnings && draft.warnings.length > 0 && (
            <div
              className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-xs text-amber-950"
              data-testid="status-template-warnings"
            >
              <p className="font-bold">Processing notes</p>
              <ul className="mt-2 list-disc space-y-1 pl-4">
                {draft.warnings.map((warning, index) => (
                  <li key={index}>{warning}</li>
                ))}
              </ul>
            </div>
          )}
        </div>

        <div className="min-w-0">
          {!draft ? (
            <Card className="flex min-h-[620px] items-center justify-center border-dashed bg-muted/20">
              <CardContent className="max-w-md p-10 text-center">
                <FileImage className="mx-auto mb-4 h-12 w-12 text-muted-foreground/30" />
                <h2 className="text-lg font-bold">Upload a sample to begin</h2>
                <p className="mt-2 text-sm text-muted-foreground">
                  After analysis, each page will be available for drawing,
                  moving, resizing, deleting, and copying redaction boxes.
                </p>
              </CardContent>
            </Card>
          ) : draft.status === "awaiting_upload" ? (
            <Card className="flex min-h-[620px] items-center justify-center border-dashed bg-muted/20">
              <CardContent className="max-w-md p-10 text-center">
                <Upload className="mx-auto mb-4 h-12 w-12 text-muted-foreground/30" />
                <h2 className="text-lg font-bold">
                  Sample upload needs attention
                </h2>
                <p className="mt-2 text-sm text-muted-foreground">
                  Choose the sample PDF again to resume this draft. Your
                  metadata and category selections remain in this browser.
                </p>
              </CardContent>
            </Card>
          ) : draft.status === "analyzing" || draft.status === "saving" ? (
            <Card className="flex min-h-[620px] items-center justify-center">
              <CardContent className="text-center">
                <Loader2 className="mx-auto mb-4 h-10 w-10 animate-spin text-primary" />
                <h2 className="font-bold">
                  {draft.status === "saving"
                    ? "Saving template…"
                    : "Analyzing sample…"}
                </h2>
                <p className="mt-2 text-sm text-muted-foreground">
                  The saved template is not changed while this draft is
                  processing.
                </p>
              </CardContent>
            </Card>
          ) : draft.status === "failed" ? (
            <Card className="border-destructive/30 bg-destructive/5">
              <CardContent className="p-10 text-center">
                <AlertTriangle className="mx-auto mb-4 h-10 w-10 text-destructive" />
                <h2 className="font-bold">Sample analysis failed</h2>
                <p className="mx-auto mt-2 max-w-lg text-sm text-muted-foreground">
                  {draft.failureMessage ?? "The PDF could not be analyzed."}
                </p>
                <p className="mt-3 text-xs text-muted-foreground">
                  Cancel this draft and try another PDF. The saved template
                  remains unchanged.
                </p>
              </CardContent>
            </Card>
          ) : (
            <div className="space-y-4">
              <TemplateRedactionEditor
                pages={editorPages}
                mode={editorMode}
                onModeChange={setEditorMode}
                onChange={setEditorPages}
                onRetrySource={() => setSourceRetryNonce((value) => value + 1)}
                disabled={
                  busyAction !== null ||
                  editorMode === "cleaned" ||
                  !sourcePreviewReady
                }
                sourceUnavailableMessage="No original source was retained for this legacy template. Replace the sample to edit its preview."
                cleanedUnavailableMessage="Generate a cleaned preview to inspect the result for this page."
              />
              <div className="flex flex-col justify-between gap-3 rounded-xl border border-border bg-card p-4 shadow-sm sm:flex-row sm:items-center">
                <div className="text-xs text-muted-foreground">
                  <span className="font-bold text-foreground">
                    {editorPages.reduce(
                      (count, page) => count + page.rects.length,
                      0,
                    )}{" "}
                    redaction boxes
                  </span>
                  {" · "}
                  {editorPages.length} analyzed{" "}
                  {editorPages.length === 1 ? "page" : "pages"}
                  {draft.sourceAvailable ? "" : " · visual source unavailable"}
                </div>
                <div className="flex flex-wrap justify-end gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    className="font-bold"
                    disabled={
                      busyAction !== null ||
                      editorPages.length === 0 ||
                      !sourcePreviewReady
                    }
                    data-testid="button-generate-template-preview"
                    onClick={() => void handlePreview()}
                  >
                    {busyAction === "preview" ? (
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    ) : (
                      <FileImage className="mr-2 h-4 w-4" />
                    )}
                    {busyAction === "preview"
                      ? "Generating…"
                      : "Generate cleaned preview"}
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    className="font-bold"
                    disabled={busyAction !== null}
                    data-testid="button-cancel-template"
                    onClick={() => void onCancel()}
                  >
                    {busyAction === "cancel" ? (
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    ) : (
                      <X className="mr-2 h-4 w-4" />
                    )}
                    Cancel
                  </Button>
                  <Button
                    type="button"
                    className="font-bold shadow-sm"
                    disabled={busyAction !== null}
                    data-testid="button-save-template"
                    onClick={() => void onSave()}
                  >
                    {busyAction === "save" ? (
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    ) : (
                      <Save className="mr-2 h-4 w-4" />
                    )}
                    {isEditing ? "Save changes" : "Save template"}
                  </Button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      <Dialog open={replaceDialogOpen} onOpenChange={setReplaceDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-amber-600" />
              Replace sample PDF?
            </DialogTitle>
            <DialogDescription>
              This explicitly starts a new draft from a replacement sample. The
              saved template, prior source artifact, and any existing cleaned or
              signed pages stay unchanged unless you save the draft.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <input
              ref={replacementInputRef}
              type="file"
              accept="application/pdf,.pdf"
              className="hidden"
              data-testid="input-replacement-template-file"
              onChange={(event) =>
                setReplacementFile(event.target.files?.[0] ?? null)
              }
            />
            <Button
              type="button"
              variant="outline"
              className="w-full font-bold"
              data-testid="button-choose-replacement-template"
              onClick={() => replacementInputRef.current?.click()}
            >
              <Upload className="mr-2 h-4 w-4" />
              {replacementFile
                ? replacementFile.name
                : "Choose replacement PDF"}
            </Button>
            {replacementFile && (
              <p className="text-xs text-muted-foreground">
                {Math.ceil(replacementFile.size / 1024)} KB · Ready to upload
              </p>
            )}
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              className="font-bold"
              data-testid="button-cancel-replace-template"
              onClick={() => setReplaceDialogOpen(false)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              className="font-bold"
              disabled={!replacementFile}
              data-testid="button-confirm-replace-template"
              onClick={() => void handleReplaceSample()}
            >
              Replace and analyze
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Shell>
  );
}
