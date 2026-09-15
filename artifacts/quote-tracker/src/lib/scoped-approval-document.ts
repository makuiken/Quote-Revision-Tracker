import { useCallback, useEffect, useRef, useState } from "react";
import { getScopedApprovalDocument } from "@workspace/api-client-react";
import { useToast } from "@/components/ui/toaster";

type ObjectUrlCleanup = () => void;

/**
 * Opens a protected scoped approval document through the authenticated API
 * client. The blank window must be opened before awaiting the fetch so the
 * browser treats it as the result of the user's click rather than a popup.
 */
export function useScopedApprovalDocument() {
  const { toast } = useToast();
  const [isOpening, setIsOpening] = useState(false);
  const cleanupsRef = useRef<Set<ObjectUrlCleanup>>(new Set());
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      for (const cleanup of cleanupsRef.current) cleanup();
      cleanupsRef.current.clear();
    };
  }, []);

  const trackObjectUrl = useCallback((objectUrl: string): ObjectUrlCleanup => {
    let cleaned = false;
    let timeoutId: number;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      window.clearTimeout(timeoutId);
      URL.revokeObjectURL(objectUrl);
      cleanupsRef.current.delete(cleanup);
    };

    cleanupsRef.current.add(cleanup);
    timeoutId = window.setTimeout(cleanup, 60_000);
    return cleanup;
  }, []);

  const openDocument = useCallback(
    async (quoteId: number, approvalId: number) => {
      // Open synchronously so popup blockers allow the tab, then populate it
      // after the authenticated API client returns the immutable PDF blob.
      const documentWindow = window.open("", "_blank");
      if (!documentWindow) {
        toast({
          title: "Could not open PDF",
          description: "Allow pop-ups for this site, then try again.",
          variant: "destructive",
        });
        return;
      }

      documentWindow.opener = null;
      setIsOpening(true);
      let cleanupObjectUrl: ObjectUrlCleanup | null = null;
      try {
        const pdf = await getScopedApprovalDocument(quoteId, approvalId, {
          responseType: "blob",
        });
        const objectUrl = URL.createObjectURL(pdf);
        if (!mountedRef.current) {
          URL.revokeObjectURL(objectUrl);
          documentWindow.close();
          return;
        }
        cleanupObjectUrl = trackObjectUrl(objectUrl);
        documentWindow.location.href = objectUrl;
      } catch (error) {
        cleanupObjectUrl?.();
        documentWindow.close();
        toast({
          title: "Could not open scoped signed PDF",
          description: error instanceof Error ? error.message : "Please try again.",
          variant: "destructive",
        });
      } finally {
        if (mountedRef.current) setIsOpening(false);
      }
    },
    [toast, trackObjectUrl],
  );

  return { isOpening, openDocument };
}