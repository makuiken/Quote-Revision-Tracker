import { forwardRef, useId, useMemo } from "react";
import {
  useListFieldOptions,
  getListFieldOptionsQueryKey,
} from "@workspace/api-client-react";
import { Input } from "@/components/ui/input";

/**
 * Fetches the admin-configured dropdown option lists and returns a lookup:
 * `optionsFor(category, field, specs?)` → string[] (empty when the field has
 * no configured options and should render as plain free text).
 *
 * Dependent fields: when a field has parent-scoped lists (e.g. Series scoped
 * by Brand), pass the current spec values for the category so the lookup can
 * read the parent field's value:
 * - Parent value selected → only the options configured for that parent
 *   (case-insensitive match); none configured for it → no suggestions.
 * - No parent value yet → the union of all configured options across parents.
 * A dependency supersedes the field's flat list on quote forms.
 */
export function useFieldOptions() {
  const { data } = useListFieldOptions({
    query: { queryKey: getListFieldOptionsQueryKey() },
  });

  return useMemo(() => {
    const flat = new Map<string, string[]>();
    type DepRow = { parentValue: string; grandValue: string; values: string[] };
    type Dep = { parentField: string; grandField: string; rows: DepRow[] };
    const deps = new Map<string, Dep>();

    for (const row of data ?? []) {
      if (row.values.length === 0) continue;
      const key = `${row.category}.${row.field}`;
      if (!row.parentField || !row.parentValue) {
        flat.set(key, row.values);
        continue;
      }
      let dep = deps.get(key);
      if (!dep) {
        dep = { parentField: row.parentField, grandField: "", rows: [] };
        deps.set(key, dep);
      }
      dep.parentField = row.parentField;
      if (row.grandField) dep.grandField = row.grandField;
      dep.rows.push({
        parentValue: row.parentValue.toLowerCase(),
        grandValue: (row.grandValue ?? "").toLowerCase(),
        values: row.values,
      });
    }

    const union = (rows: DepRow[]): string[] => {
      const out: string[] = [];
      for (const r of rows) {
        for (const v of r.values) {
          if (!out.some((x) => x.toLowerCase() === v.toLowerCase())) out.push(v);
        }
      }
      return out;
    };

    const specString = (
      specs: Record<string, unknown> | null | undefined,
      field: string,
    ): string => {
      const raw = field ? specs?.[field] : undefined;
      return typeof raw === "string" ? raw.trim().toLowerCase() : "";
    };

    const optionsFor = (
      category: string,
      field: string,
      specs?: Record<string, unknown> | null,
    ): string[] => {
      const key = `${category}.${field}`;
      const dep = deps.get(key);
      if (dep) {
        const parent = specString(specs, dep.parentField);
        const grand = specString(specs, dep.grandField);
        let rows = dep.rows;
        if (parent) rows = rows.filter((r) => r.parentValue === parent);
        if (grand) {
          // Prefer lists scoped to this exact ancestor; keep unscoped
          // (one-level legacy) lists as a fallback when nothing matches.
          const exact = rows.filter((r) => r.grandValue === grand);
          rows = exact.length > 0 ? exact : rows.filter((r) => !r.grandValue);
        }
        return union(rows);
      }
      return flat.get(key) ?? [];
    };

    return { optionsFor };
  }, [data]);
}

type SpecInputProps = React.ComponentProps<typeof Input> & {
  /** Configured options; empty/undefined renders a plain text input. */
  options?: string[];
};

/**
 * Text input that becomes a combobox (native datalist) when options exist:
 * the user can pick a configured value or type any custom one. Existing
 * out-of-list values display and persist untouched because the underlying
 * control is still a free-text input.
 */
export const SpecInput = forwardRef<HTMLInputElement, SpecInputProps>(
  function SpecInput({ options, ...props }, ref) {
    const listId = useId();
    if (!options || options.length === 0) {
      return <Input ref={ref} {...props} />;
    }
    return (
      <>
        <Input ref={ref} list={listId} autoComplete="off" {...props} />
        <datalist id={listId}>
          {options.map((value) => (
            <option key={value} value={value} />
          ))}
        </datalist>
      </>
    );
  },
);
