import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Settings, Shield, Plus, Trash2, ArrowUp, ArrowDown, Pencil, Check, X } from "lucide-react";
import {
  useGetCurrentUser,
  useListFieldOptions,
  getListFieldOptionsQueryKey,
  useSetFieldOptions,
  useDeleteFieldOptions,
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
import { useToast } from "@/components/ui/toaster";
import { WINDOW_FIELDS, INTERIOR_DOOR_FIELDS, EXTERIOR_DOOR_FIELDS } from "@/lib/spec-fields";

type OptionCategory = "window" | "interiorDoor" | "exteriorDoor";

const CATEGORY_DEFS: { key: OptionCategory; label: string; fields: { key: string; label: string }[] }[] = [
  { key: "window", label: "Windows", fields: WINDOW_FIELDS },
  { key: "interiorDoor", label: "Interior Doors", fields: INTERIOR_DOOR_FIELDS },
  { key: "exteriorDoor", label: "Exterior Doors", fields: EXTERIOR_DOOR_FIELDS },
];

export default function FieldOptionsPage() {
  const { data: dbUser } = useGetCurrentUser();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const { data: allOptions } = useListFieldOptions({
    query: { queryKey: getListFieldOptionsQueryKey() },
  });
  const setOptions = useSetFieldOptions();
  const deleteOptions = useDeleteFieldOptions();

  const [category, setCategory] = useState<OptionCategory>("window");
  const [fieldKey, setFieldKey] = useState<string>(WINDOW_FIELDS[0]!.key);
  const [newValue, setNewValue] = useState("");
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [editingValue, setEditingValue] = useState("");

  const categoryDef = CATEGORY_DEFS.find((c) => c.key === category)!;
  const values = useMemo(
    () =>
      allOptions?.find((o) => o.category === category && o.field === fieldKey)
        ?.values ?? [],
    [allOptions, category, fieldKey],
  );

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

  const save = (nextValues: string[], successTitle: string) => {
    const mutation =
      nextValues.length === 0
        ? deleteOptions.mutateAsync({ category, field: fieldKey })
        : setOptions.mutateAsync({ category, field: fieldKey, data: { values: nextValues } });
    mutation
      .then(() => {
        queryClient.invalidateQueries({ queryKey: getListFieldOptionsQueryKey() });
        toast({ title: successTitle });
      })
      .catch((err: any) => {
        toast({
          title: "Error",
          description: err?.data?.error || "Failed to save options.",
          variant: "destructive",
        });
      });
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

  const isSaving = setOptions.isPending || deleteOptions.isPending;
  const fieldLabel = categoryDef.fields.find((f) => f.key === fieldKey)?.label ?? fieldKey;

  return (
    <Shell>
      <div className="mb-8">
        <h1 className="text-3xl font-serif font-bold text-primary mb-2 flex items-center gap-3">
          <Settings className="w-8 h-8" /> Field Options
        </h1>
        <p className="text-muted-foreground font-medium max-w-2xl">
          Set the dropdown choices for product spec fields. Fields with options become dropdowns
          on quote forms (custom values can still be typed); fields without options stay free text.
          Changing options never alters existing quotes.
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
            <Label className="text-base">
              Options for {categoryDef.label} → {fieldLabel}
            </Label>

            {values.length === 0 ? (
              <p className="text-sm text-muted-foreground font-medium py-2">
                No options configured — this field is currently free text on quote forms.
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
                        >
                          <Trash2 className="w-4 h-4" />
                        </Button>
                      </>
                    )}
                  </li>
                ))}
              </ul>
            )}

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
          </div>
        </CardContent>
      </Card>
    </Shell>
  );
}
