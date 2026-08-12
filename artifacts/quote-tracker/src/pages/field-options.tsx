import { useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Settings, Shield, Plus, Trash2, ArrowUp, ArrowDown, Pencil, Check, X, Link2, Link2Off } from "lucide-react";
import {
  useGetCurrentUser,
  useListFieldOptions,
  getListFieldOptionsQueryKey,
  useSetFieldOptions,
  useDeleteFieldOptions,
  useSetDependentFieldOptions,
  useDeleteDependentFieldOptions,
  useClearFieldDependency,
} from "@workspace/api-client-react";
import { Shell } from "@/components/layout";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useToast } from "@/components/ui/toaster";
import { WINDOW_FIELDS, INTERIOR_DOOR_FIELDS, EXTERIOR_DOOR_FIELDS } from "@/lib/spec-fields";

type OptionCategory = "window" | "interiorDoor" | "exteriorDoor";

const CATEGORY_DEFS: { key: OptionCategory; label: string; fields: { key: string; label: string }[] }[] = [
  { key: "window", label: "Windows", fields: WINDOW_FIELDS },
  { key: "interiorDoor", label: "Interior Doors", fields: INTERIOR_DOOR_FIELDS },
  { key: "exteriorDoor", label: "Exterior Doors", fields: EXTERIOR_DOOR_FIELDS },
];

const NONE = "__none__";

type ConfirmState = {
  title: string;
  description: string;
  actionLabel: string;
  onConfirm: () => void;
} | null;

export default function FieldOptionsPage() {
  const { data: dbUser } = useGetCurrentUser();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const { data: allOptions } = useListFieldOptions({
    query: { queryKey: getListFieldOptionsQueryKey() },
  });
  const setOptions = useSetFieldOptions();
  const deleteOptions = useDeleteFieldOptions();
  const setDependentOptions = useSetDependentFieldOptions();
  const deleteDependentOptions = useDeleteDependentFieldOptions();
  const clearDependency = useClearFieldDependency();

  const [category, setCategory] = useState<OptionCategory>("window");
  const [fieldKey, setFieldKey] = useState<string>(WINDOW_FIELDS[0]!.key);
  const [newValue, setNewValue] = useState("");
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [editingValue, setEditingValue] = useState("");
  // Dependency editing state.
  const [parentChoice, setParentChoice] = useState<string>("");
  const [grandValueSel, setGrandValueSel] = useState<string>("");
  const [parentValue, setParentValue] = useState<string>("");
  const [newParentValue, setNewParentValue] = useState("");
  const [confirm, setConfirm] = useState<ConfirmState>(null);

  const categoryDef = CATEGORY_DEFS.find((c) => c.key === category)!;

  const fieldRows = useMemo(
    () => (allOptions ?? []).filter((o) => o.category === category && o.field === fieldKey),
    [allOptions, category, fieldKey],
  );
  const flatValues = fieldRows.find((o) => !o.parentValue)?.values ?? [];
  const depRows = useMemo(() => fieldRows.filter((o) => o.parentValue), [fieldRows]);
  const configuredParent = depRows[0]?.parentField ?? "";

  // If the chosen parent field itself depends on another field, editing this
  // field's lists is two-level: pick the grandparent value first (e.g. Brand),
  // then the parent value (e.g. Series), then the option list (e.g. Colors).
  const grandField = useMemo(() => {
    if (!parentChoice) return "";
    const parentDepRow = (allOptions ?? []).find(
      (o) => o.category === category && o.field === parentChoice && o.parentValue,
    );
    return parentDepRow?.parentField ?? "";
  }, [allOptions, category, parentChoice]);
  const twoLevel = Boolean(parentChoice && grandField);

  // Sync the dependency selector when the selected field (or server data) changes.
  useEffect(() => {
    setParentChoice(configuredParent);
    setGrandValueSel("");
    setParentValue("");
    setNewParentValue("");
    setEditingIndex(null);
  }, [category, fieldKey, configuredParent]);

  // Reset downstream picks when upstream picks change.
  useEffect(() => {
    setParentValue("");
    setNewParentValue("");
    setEditingIndex(null);
  }, [grandValueSel]);

  const dedupeCaseInsensitive = (lists: string[][]): string[] => {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const list of lists) {
      for (const v of list) {
        if (seen.has(v.toLowerCase())) continue;
        seen.add(v.toLowerCase());
        out.push(v);
      }
    }
    return out;
  };

  // Choices for the grandparent value (two-level only): the grand field's flat
  // list, plus values already used by the parent's scoped lists or this
  // field's scoped lists.
  const grandValueChoices = useMemo(() => {
    if (!twoLevel) return [];
    const rows = allOptions ?? [];
    const grandFlat =
      rows.find((o) => o.category === category && o.field === grandField && !o.parentValue)?.values ?? [];
    const fromParentLists = rows
      .filter((o) => o.category === category && o.field === parentChoice && o.parentValue)
      .map((o) => o.parentValue);
    const fromOwnLists = depRows.filter((r) => r.grandValue).map((r) => r.grandValue);
    return dedupeCaseInsensitive([grandFlat, fromParentLists, fromOwnLists]);
  }, [twoLevel, allOptions, category, grandField, parentChoice, depRows]);

  // Parent values available: for two-level chains, the parent's option list
  // scoped to the chosen grandparent value; otherwise the parent's flat list.
  // Either way, include values that already have a scoped list here.
  const parentValueChoices = useMemo(() => {
    if (!parentChoice) return [];
    const rows = allOptions ?? [];
    let base: string[];
    if (twoLevel) {
      if (!grandValueSel) return [];
      base =
        rows.find(
          (o) =>
            o.category === category &&
            o.field === parentChoice &&
            o.parentValue.toLowerCase() === grandValueSel.toLowerCase(),
        )?.values ?? [];
    } else {
      base =
        rows.find((o) => o.category === category && o.field === parentChoice && !o.parentValue)
          ?.values ?? [];
    }
    const existing = depRows
      .filter(
        (r) =>
          r.parentField === parentChoice &&
          (!twoLevel || r.grandValue.toLowerCase() === grandValueSel.toLowerCase()),
      )
      .map((r) => r.parentValue);
    return dedupeCaseInsensitive([base, existing]);
  }, [allOptions, category, parentChoice, twoLevel, grandValueSel, depRows]);

  const dependent = parentChoice !== "";
  const currentDepRow = dependent
    ? depRows.find(
        (r) =>
          r.parentField === parentChoice &&
          r.parentValue.toLowerCase() === parentValue.toLowerCase() &&
          (twoLevel
            ? r.grandValue.toLowerCase() === grandValueSel.toLowerCase()
            : !r.grandValue),
      )
    : undefined;
  const values = dependent ? currentDepRow?.values ?? [] : flatValues;

  if (dbUser && dbUser.role !== "admin") {
    return (
      <Shell>
        <div className="flex flex-col items-center justify-center py-20 text-center">
          <Shield className="w-16 h-16 text-muted-foreground/50 mb-4" />
          <h1 className="text-2xl font-serif font-bold text-foreground mb-2">Admins Only</h1>
          <p className="text-muted-foreground font-medium">You do not have permission to view this page.</p>
        </div>
      </Shell>
    );
  }

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: getListFieldOptionsQueryKey() });

  const onError = (err: any) => {
    toast({
      title: "Error",
      description: err?.data?.error || "Failed to save options.",
      variant: "destructive",
    });
  };

  const fieldLabel = categoryDef.fields.find((f) => f.key === fieldKey)?.label ?? fieldKey;
  const parentLabel = categoryDef.fields.find((f) => f.key === parentChoice)?.label ?? parentChoice;
  const grandLabel = categoryDef.fields.find((f) => f.key === grandField)?.label ?? grandField;
  const configuredParentLabel =
    categoryDef.fields.find((f) => f.key === configuredParent)?.label ?? configuredParent;

  const scopeLabel = dependent
    ? twoLevel
      ? `${grandLabel} “${grandValueSel}” → ${parentLabel} “${parentValue}”`
      : `${parentLabel} “${parentValue}”`
    : "";

  const doSave = (nextValues: string[], successTitle: string, replaceExisting?: boolean) => {
    let mutation: Promise<unknown>;
    if (dependent) {
      if (!parentValue.trim()) return;
      mutation =
        nextValues.length === 0
          ? deleteDependentOptions.mutateAsync({
              category,
              field: fieldKey,
              parentValue,
              params: twoLevel ? { grandValue: grandValueSel } : undefined,
            })
          : setDependentOptions.mutateAsync({
              category,
              field: fieldKey,
              data: {
                parentField: parentChoice,
                parentValue,
                ...(twoLevel ? { grandField, grandValue: grandValueSel } : {}),
                ...(replaceExisting ? { replaceExisting: true } : {}),
                values: nextValues,
              },
            });
    } else {
      mutation =
        nextValues.length === 0
          ? deleteOptions.mutateAsync({ category, field: fieldKey })
          : setOptions.mutateAsync({ category, field: fieldKey, data: { values: nextValues } });
    }
    mutation
      .then(() => {
        invalidate();
        toast({ title: successTitle });
      })
      .catch((err: any) => {
        // The server rejects saves that would change the dependency chain and
        // delete other lists; surface that as an explicit confirmation.
        // (Deletes never take replaceExisting — their 409s, e.g. "other
        // fields depend on this", are shown as plain errors.)
        if (err?.status === 409 && !replaceExisting && nextValues.length > 0) {
          setConfirm({
            title: "Replace this field's dependency?",
            description:
              err?.data?.error ||
              "Saving will change the dependency and delete existing lists.",
            actionLabel: "Replace and delete",
            onConfirm: () => doSave(nextValues, successTitle, true),
          });
          return;
        }
        onError(err);
      });
  };

  const save = (nextValues: string[], successTitle: string) => {
    if (nextValues.length === 0 && values.length > 0) {
      // Emptying a list deletes it entirely — make sure that's intended.
      setConfirm({
        title: dependent ? "Delete this option list?" : "Delete this field's option list?",
        description: dependent
          ? `Removing the last option deletes the entire ${fieldLabel} list for ${scopeLabel}. Existing quotes keep their values.`
          : `Removing the last option deletes the ${fieldLabel} list, and the field goes back to free text on quote forms. Existing quotes keep their values.`,
        actionLabel: "Delete list",
        onConfirm: () => doSave([], "List deleted"),
      });
      return;
    }
    doSave(nextValues, successTitle);
  };

  const handleAdd = () => {
    const v = newValue.trim();
    if (!v) return;
    if (values.some((x) => x.toLowerCase() === v.toLowerCase())) {
      toast({ title: "Already in the list", description: `"${v}" is already an option.`, variant: "destructive" });
      return;
    }
    setNewValue("");
    save([...values, v], "Option added");
  };

  const handleRename = (index: number) => {
    const v = editingValue.trim();
    setEditingIndex(null);
    if (!v || v === values[index]) return;
    if (values.some((x, i) => i !== index && x.toLowerCase() === v.toLowerCase())) {
      toast({ title: "Already in the list", description: `"${v}" is already an option.`, variant: "destructive" });
      return;
    }
    const next = [...values];
    next[index] = v;
    save(next, "Option renamed");
  };

  const handleMove = (index: number, delta: -1 | 1) => {
    const target = index + delta;
    if (target < 0 || target >= values.length) return;
    const next = [...values];
    [next[index], next[target]] = [next[target]!, next[index]!];
    save(next, "Order updated");
  };

  const handleRemove = (index: number) => {
    save(values.filter((_, i) => i !== index), "Option removed");
  };

  const handleRemoveDependency = () => {
    const count = depRows.length;
    const parents = dedupeCaseInsensitive([depRows.map((r) => r.parentValue)]);
    setConfirm({
      title: "Remove this dependency?",
      description: `This deletes all ${count} ${fieldLabel} list${count === 1 ? "" : "s"} configured for ${configuredParentLabel} (${parents.slice(0, 6).join(", ")}${parents.length > 6 ? ", …" : ""}). The field goes back to its flat option list or free text. Existing quotes keep their values.`,
      actionLabel: "Remove dependency",
      onConfirm: () => {
        clearDependency
          .mutateAsync({ category, field: fieldKey })
          .then(() => {
            invalidate();
            setParentChoice("");
            setGrandValueSel("");
            setParentValue("");
            toast({ title: "Dependency removed", description: "The field now uses its flat option list (or free text)." });
          })
          .catch(onError);
      },
    });
  };

  const isSaving =
    setOptions.isPending ||
    deleteOptions.isPending ||
    setDependentOptions.isPending ||
    deleteDependentOptions.isPending ||
    clearDependency.isPending;

  const canEditList =
    !dependent || (parentValue.trim() !== "" && (!twoLevel || grandValueSel.trim() !== ""));

  return (
    <Shell>
      <div className="mb-8">
        <h1 className="text-3xl font-serif font-bold text-primary mb-2 flex items-center gap-3">
          <Settings className="w-8 h-8" /> Field Options
        </h1>
        <p className="text-muted-foreground font-medium max-w-2xl">
          Set the dropdown choices for product spec fields. Fields with options become dropdowns
          on quote forms (custom values can still be typed); fields without options stay free text.
          A field can also depend on another field (e.g. Series depends on Brand) — and chains
          work too: if Color depends on Series and Series depends on Brand, Color lists are kept
          per Brand + Series combination. Changing options never alters existing quotes.
        </p>
      </div>

      <Card className="max-w-3xl">
        <CardHeader className="pb-4">
          <CardTitle>Choose a field</CardTitle>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>Product Category</Label>
              <Select
                value={category}
                onValueChange={(v) => {
                  const def = CATEGORY_DEFS.find((c) => c.key === v)!;
                  setCategory(v as OptionCategory);
                  setFieldKey(def.fields[0]!.key);
                  setEditingIndex(null);
                }}
              >
                <SelectTrigger data-testid="select-category"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {CATEGORY_DEFS.map((c) => (
                    <SelectItem key={c.key} value={c.key}>{c.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Field</Label>
              <Select
                value={fieldKey}
                onValueChange={(v) => {
                  setFieldKey(v);
                  setEditingIndex(null);
                }}
              >
                <SelectTrigger data-testid="select-field"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {categoryDef.fields.map((f) => (
                    <SelectItem key={f.key} value={f.key}>{f.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-3 pt-4 border-t-2 border-border">
            <Label className="text-base flex items-center gap-2">
              <Link2 className="w-4 h-4" /> Dependency
            </Label>
            <p className="text-sm text-muted-foreground font-medium">
              Make {fieldLabel} offer a different option list depending on another field's value
              (e.g. Series depends on Brand). If the field it depends on has its own dependency,
              lists are kept per combination (e.g. Color per Brand + Series).
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 items-end">
              <div className="space-y-2">
                <Label>Depends on</Label>
                <Select
                  value={parentChoice || NONE}
                  onValueChange={(v) => {
                    setParentChoice(v === NONE ? "" : v);
                    setGrandValueSel("");
                    setParentValue("");
                    setEditingIndex(null);
                  }}
                >
                  <SelectTrigger data-testid="select-depends-on"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NONE}>None (single flat list)</SelectItem>
                    {categoryDef.fields
                      .filter((f) => f.key !== fieldKey)
                      .map((f) => (
                        <SelectItem key={f.key} value={f.key}>{f.label}</SelectItem>
                      ))}
                  </SelectContent>
                </Select>
              </div>
              {configuredParent && (
                <Button
                  variant="outline"
                  disabled={isSaving}
                  onClick={handleRemoveDependency}
                  data-testid="button-remove-dependency"
                >
                  <Link2Off className="w-4 h-4 mr-2" /> Remove dependency
                </Button>
              )}
            </div>
            {configuredParent && !parentChoice && (
              <p className="text-sm text-muted-foreground font-medium">
                {fieldLabel} currently depends on {configuredParentLabel}.
                Use “Remove dependency” to go back to a single flat list.
              </p>
            )}
            {dependent && configuredParent && parentChoice !== configuredParent && (
              <p className="text-sm text-destructive font-medium">
                Saving a list under {parentLabel} will replace the existing dependency on{" "}
                {configuredParentLabel} — you'll be asked to confirm before anything is deleted.
              </p>
            )}
            {twoLevel && (
              <p className="text-sm text-muted-foreground font-medium">
                {parentLabel} depends on {grandLabel}, so {fieldLabel} lists are kept per{" "}
                {grandLabel} + {parentLabel} combination.
              </p>
            )}
            {dependent && (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                {twoLevel && (
                  <div className="space-y-2">
                    <Label>{grandLabel} value</Label>
                    <Select
                      value={grandValueSel || NONE}
                      onValueChange={(v) => {
                        setGrandValueSel(v === NONE ? "" : v);
                      }}
                    >
                      <SelectTrigger data-testid="select-grand-value">
                        <SelectValue placeholder={`Choose a ${grandLabel} value`} />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value={NONE}>— choose —</SelectItem>
                        {grandValueChoices.map((v) => (
                          <SelectItem key={v} value={v}>{v}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                )}
                <div className="space-y-2">
                  <Label>{parentLabel} value</Label>
                  <Select
                    value={parentValue || NONE}
                    onValueChange={(v) => {
                      setParentValue(v === NONE ? "" : v);
                      setEditingIndex(null);
                    }}
                    disabled={twoLevel && !grandValueSel}
                  >
                    <SelectTrigger data-testid="select-parent-value">
                      <SelectValue
                        placeholder={
                          twoLevel && !grandValueSel
                            ? `Choose a ${grandLabel} value first`
                            : `Choose a ${parentLabel} value`
                        }
                      />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={NONE}>— choose —</SelectItem>
                      {parentValueChoices.map((v) => (
                        <SelectItem key={v} value={v}>
                          {v}
                          {depRows.some(
                            (r) =>
                              r.parentField === parentChoice &&
                              r.parentValue.toLowerCase() === v.toLowerCase() &&
                              (!twoLevel || r.grandValue.toLowerCase() === grandValueSel.toLowerCase()),
                          )
                            ? " ✓"
                            : ""}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label>Or add a new {parentLabel} value</Label>
                  <div className="flex items-center gap-2">
                    <Input
                      placeholder={`e.g. Andersen`}
                      value={newParentValue}
                      maxLength={120}
                      disabled={twoLevel && !grandValueSel}
                      onChange={(e) => setNewParentValue(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          const v = newParentValue.trim();
                          if (!v) return;
                          setParentValue(v);
                          setNewParentValue("");
                        }
                      }}
                      data-testid="input-new-parent-value"
                    />
                    <Button
                      variant="outline"
                      disabled={!newParentValue.trim() || (twoLevel && !grandValueSel)}
                      onClick={() => {
                        const v = newParentValue.trim();
                        if (!v) return;
                        setParentValue(v);
                        setNewParentValue("");
                      }}
                      data-testid="button-use-parent-value"
                    >
                      Use
                    </Button>
                  </div>
                </div>
              </div>
            )}
          </div>

          <div className="space-y-3 pt-4 border-t-2 border-border">
            <Label className="text-base">
              Options for {categoryDef.label} → {fieldLabel}
              {dependent && canEditList ? ` (when ${scopeLabel})` : ""}
            </Label>

            {!canEditList ? (
              <p className="text-sm text-muted-foreground font-medium py-2">
                {twoLevel && !grandValueSel
                  ? `Choose a ${grandLabel} value above to get started.`
                  : `Choose a ${parentLabel} value above to edit its ${fieldLabel} options.`}
              </p>
            ) : values.length === 0 ? (
              <p className="text-sm text-muted-foreground font-medium py-2">
                {dependent
                  ? `No options configured for this ${twoLevel ? "combination" : `${parentLabel} value`} yet.`
                  : "No options configured — this field is currently free text on quote forms."}
              </p>
            ) : (
              <ul className="space-y-2">
                {values.map((value, index) => (
                  <li
                    key={`${value}-${index}`}
                    className="flex items-center gap-2 p-2.5 border-2 border-border rounded-lg bg-card"
                    data-testid={`option-row-${index}`}
                  >
                    {editingIndex === index ? (
                      <>
                        <Input
                          value={editingValue}
                          autoFocus
                          onChange={(e) => setEditingValue(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") handleRename(index);
                            if (e.key === "Escape") setEditingIndex(null);
                          }}
                          className="h-8"
                        />
                        <Button variant="ghost" size="sm" className="h-8 w-8 p-0" title="Save" onClick={() => handleRename(index)}>
                          <Check className="w-4 h-4" />
                        </Button>
                        <Button variant="ghost" size="sm" className="h-8 w-8 p-0" title="Cancel" onClick={() => setEditingIndex(null)}>
                          <X className="w-4 h-4" />
                        </Button>
                      </>
                    ) : (
                      <>
                        <span className="flex-1 font-medium truncate">{value}</span>
                        <Button
                          variant="ghost" size="sm" className="h-8 w-8 p-0" title="Move up"
                          disabled={index === 0 || isSaving}
                          onClick={() => handleMove(index, -1)}
                        >
                          <ArrowUp className="w-4 h-4" />
                        </Button>
                        <Button
                          variant="ghost" size="sm" className="h-8 w-8 p-0" title="Move down"
                          disabled={index === values.length - 1 || isSaving}
                          onClick={() => handleMove(index, 1)}
                        >
                          <ArrowDown className="w-4 h-4" />
                        </Button>
                        <Button
                          variant="ghost" size="sm" className="h-8 w-8 p-0" title="Rename"
                          disabled={isSaving}
                          onClick={() => { setEditingIndex(index); setEditingValue(value); }}
                        >
                          <Pencil className="w-4 h-4" />
                        </Button>
                        <Button
                          variant="ghost" size="sm"
                          className="h-8 w-8 p-0 text-destructive hover:text-destructive"
                          title="Remove" disabled={isSaving}
                          onClick={() => handleRemove(index)}
                          data-testid={`button-remove-option-${index}`}
                        >
                          <Trash2 className="w-4 h-4" />
                        </Button>
                      </>
                    )}
                  </li>
                ))}
              </ul>
            )}

            {canEditList && (
              <div className="flex items-center gap-2 pt-2">
                <Input
                  placeholder="Add an option (e.g. Andersen)"
                  value={newValue}
                  maxLength={120}
                  onChange={(e) => setNewValue(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      handleAdd();
                    }
                  }}
                  data-testid="input-new-option"
                />
                <Button onClick={handleAdd} disabled={!newValue.trim() || isSaving} data-testid="button-add-option">
                  <Plus className="w-4 h-4 mr-2" /> Add
                </Button>
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      <AlertDialog open={confirm !== null} onOpenChange={(open) => { if (!open) setConfirm(null); }}>
        <AlertDialogContent data-testid="dialog-confirm-destructive">
          <AlertDialogHeader>
            <AlertDialogTitle>{confirm?.title}</AlertDialogTitle>
            <AlertDialogDescription>{confirm?.description}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-confirm-cancel">Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              data-testid="button-confirm-action"
              onClick={() => {
                const action = confirm?.onConfirm;
                setConfirm(null);
                action?.();
              }}
            >
              {confirm?.actionLabel}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Shell>
  );
}
