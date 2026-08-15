import * as React from "react";
import { Loader2, MapPin } from "lucide-react";
import { Popover, PopoverContent, PopoverAnchor } from "@/components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

interface NominatimAddress {
  house_number?: string;
  road?: string;
  city?: string;
  town?: string;
  village?: string;
  suburb?: string;
  county?: string;
  state?: string;
  "ISO3166-2-lvl4"?: string; // e.g. "US-NJ" → "NJ"
  postcode?: string;
}

interface NominatimResult {
  place_id: number;
  display_name: string;
  address: NominatimAddress;
}

interface FormattedResult extends NominatimResult {
  formatted: string;
}

function formatAddress(result: NominatimResult): string {
  const a = result.address;
  const street = [a.house_number, a.road].filter(Boolean).join(" ");
  const city = a.city ?? a.town ?? a.village ?? a.suburb ?? a.county ?? "";
  const stateCode = a["ISO3166-2-lvl4"]?.split("-")[1] ?? a.state ?? "";
  const zip = a.postcode?.split("-")[0] ?? ""; // trim ZIP+4 to 5 digits
  const parts = [street, city ? `${city}` : "", stateCode, zip]
    .map((p) => p.trim())
    .filter(Boolean);
  // Build "street, city, ST zip" — or fall back to display_name
  if (street && city && stateCode) {
    return `${street}, ${city}, ${stateCode}${zip ? " " + zip : ""}`;
  }
  return result.display_name;
}

interface AddressAutocompleteProps {
  value: string;
  onChange: (value: string) => void;
  onBlur?: () => void;
  id?: string;
  placeholder?: string;
  className?: string;
  disabled?: boolean;
}

export function AddressAutocomplete({
  value,
  onChange,
  onBlur,
  id,
  placeholder = "e.g. 123 Main St, City, ST 12345",
  className,
  disabled,
}: AddressAutocompleteProps) {
  const [inputValue, setInputValue] = React.useState(value ?? "");
  const [suggestions, setSuggestions] = React.useState<FormattedResult[]>([]);
  const [isLoading, setIsLoading] = React.useState(false);
  const [open, setOpen] = React.useState(false);
  const debounceRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortRef = React.useRef<AbortController | null>(null);

  // Sync external value → input (e.g. on form reset)
  React.useEffect(() => {
    setInputValue(value ?? "");
  }, [value]);

  const fetchSuggestions = React.useCallback(async (query: string) => {
    if (abortRef.current) abortRef.current.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setIsLoading(true);
    try {
      const url = new URL("https://nominatim.openstreetmap.org/search");
      url.searchParams.set("format", "json");
      url.searchParams.set("addressdetails", "1");
      url.searchParams.set("limit", "6");
      url.searchParams.set("countrycodes", "us");
      url.searchParams.set("q", query);

      const res = await fetch(url.toString(), {
        signal: controller.signal,
        headers: {
          // Nominatim requires identification; Referer is the client-safe header
          Referer: window.location.origin,
        },
      });
      if (!res.ok) throw new Error("Nominatim request failed");
      const raw: NominatimResult[] = await res.json();
      // Pre-compute formatted labels so rendering is pure
      const data: FormattedResult[] = raw.map((r) => ({ ...r, formatted: formatAddress(r) }));
      setSuggestions(data);
      setOpen(data.length > 0 || query.length >= 3); // keep open to show empty state
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        // Silently degrade — user can still type free text
        setSuggestions([]);
      }
    } finally {
      setIsLoading(false);
    }
  }, []);

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const raw = e.target.value;
    setInputValue(raw);
    onChange(raw); // keep form value in sync as user types

    if (debounceRef.current) clearTimeout(debounceRef.current);

    if (raw.length < 3) {
      setSuggestions([]);
      setOpen(false);
      return;
    }

    debounceRef.current = setTimeout(() => {
      fetchSuggestions(raw);
    }, 400);
  };

  const handleSelect = (displayName: string) => {
    setInputValue(displayName);
    onChange(displayName);
    setSuggestions([]);
    setOpen(false);
  };

  const handleBlur = () => {
    // Small delay so clicks on items register before closing
    setTimeout(() => {
      setOpen(false);
      onBlur?.();
    }, 150);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverAnchor asChild>
        <div className="relative">
          <Input
            id={id}
            value={inputValue}
            onChange={handleInputChange}
            onBlur={handleBlur}
            onFocus={() => {
              if (suggestions.length > 0) setOpen(true);
            }}
            placeholder={placeholder}
            className={cn("pr-8", className)}
            disabled={disabled}
            autoComplete="off"
          />
          {isLoading && (
            <Loader2 className="absolute right-2.5 top-1/2 -translate-y-1/2 h-4 w-4 animate-spin text-muted-foreground" />
          )}
          {!isLoading && inputValue.length >= 3 && (
            <MapPin className="absolute right-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground/50 pointer-events-none" />
          )}
        </div>
      </PopoverAnchor>

      <PopoverContent
        className="p-0 w-[--radix-popover-trigger-width]"
        align="start"
        sideOffset={4}
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        <Command shouldFilter={false}>
          <CommandList>
            {!isLoading && suggestions.length === 0 && (
              <CommandEmpty className="py-4 text-sm text-muted-foreground">
                No results found.
              </CommandEmpty>
            )}
            {suggestions.length > 0 && (
              <CommandGroup>
                {suggestions.map((item) => (
                  <CommandItem
                    key={item.place_id}
                    value={item.formatted}
                    onSelect={() => handleSelect(item.formatted)}
                    className="cursor-pointer"
                  >
                    <MapPin className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    <span className="truncate">{item.formatted}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
