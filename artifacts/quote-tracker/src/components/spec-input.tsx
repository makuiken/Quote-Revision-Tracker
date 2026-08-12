import { forwardRef, useId } from "react";
import {
  useListFieldOptions,
  getListFieldOptionsQueryKey,
} from "@workspace/api-client-react";
import { Input } from "@/components/ui/input";

/**
 * Fetches the admin-configured dropdown option lists and returns a lookup:
 * `optionsFor(category, field)` → string[] (empty when the field has no
 * configured options and should render as plain free text).
 */
export function useFieldOptions() {
  const { data } = useListFieldOptions({
    query: { queryKey: getListFieldOptionsQueryKey() },
  });
  const map = new Map<string, string[]>();
  for (const row of data ?? []) {
    if (row.values.length > 0) map.set(`${row.category}.${row.field}`, row.values);
  }
  return {
    optionsFor: (category: string, field: string): string[] =>
      map.get(`${category}.${field}`) ?? [],
  };
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
