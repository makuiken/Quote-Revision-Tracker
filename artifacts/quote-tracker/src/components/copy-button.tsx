import { useEffect, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { copyTextToClipboard } from "@/lib/copy-text";

interface CopyButtonProps {
  /** Returns the exact plain text to place on the clipboard. */
  getText: () => string;
  title?: string;
  /** Optional visible label; icon-only when omitted. */
  label?: string;
  copiedLabel?: string;
  className?: string;
  variant?: "ghost" | "outline";
  disabled?: boolean;
}

/**
 * Small copy-to-clipboard button with a transient checkmark confirmation.
 */
export function CopyButton({
  getText,
  title = "Copy",
  label,
  copiedLabel = "Copied",
  className = "",
  variant = "ghost",
  disabled,
}: CopyButtonProps) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => () => clearTimeout(timerRef.current), []);

  const handleCopy = async () => {
    await copyTextToClipboard(getText());
    setCopied(true);
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setCopied(false), 2000);
  };

  return (
    <Button
      type="button"
      variant={variant}
      size="sm"
      title={title}
      aria-label={title}
      disabled={disabled}
      onClick={handleCopy}
      className={`${label ? "" : "h-7 w-7 p-0"} shrink-0 ${className}`}
    >
      {copied ? (
        <Check className={`w-3.5 h-3.5 text-green-600 ${label ? "mr-1.5" : ""}`} />
      ) : (
        <Copy className={`w-3.5 h-3.5 ${label ? "mr-1.5" : ""}`} />
      )}
      {label ? (copied ? copiedLabel : label) : null}
    </Button>
  );
}
