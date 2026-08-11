import { useParams } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetPublicSignoff,
  getGetPublicSignoffQueryKey,
  useSavePublicSignoff,
} from "@workspace/api-client-react";
import { useToast } from "@/components/ui/toaster";
import { SignoffDocument } from "@/components/signoff-document";

/**
 * Public, customer-facing signing page. Reached via a tokenized share link —
 * no account or login required. The token gates all API access.
 */
export default function PublicSignoffPage() {
  const { token } = useParams();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data: detail, isLoading, isError } = useGetPublicSignoff(token ?? "", {
    query: { enabled: !!token, queryKey: getGetPublicSignoffQueryKey(token ?? "") },
  });

  const savePublicSignoff = useSavePublicSignoff();

  if (isLoading) {
    return (
      <div className="min-h-[100dvh] bg-gray-100 flex items-center justify-center text-gray-500">
        Loading document...
      </div>
    );
  }

  if (isError || !detail) {
    return (
      <div className="min-h-[100dvh] bg-gray-100 flex items-center justify-center p-8">
        <div className="bg-white border border-gray-200 rounded-lg shadow-lg p-8 max-w-md text-center">
          <h1 className="text-xl font-serif font-bold mb-2">Link Not Valid</h1>
          <p className="text-gray-600">
            This signing link is invalid or no longer active. Please contact your
            Kuiken Brothers representative for a new link.
          </p>
        </div>
      </div>
    );
  }

  const { quote, revisions, signoff } = detail;

  const submitSignoff = (type: "typed" | "drawn", data: string) => {
    savePublicSignoff.mutate(
      {
        token: token!,
        data: {
          customerName: quote.customerName,
          signatureType: type,
          signatureData: data,
          documentVersion: detail.documentVersion,
        },
      },
      {
        onSuccess: () => {
          toast({ title: "Thank You!", description: "Your signature has been recorded." });
          queryClient.invalidateQueries({ queryKey: getGetPublicSignoffQueryKey(token!) });
        },
        onError: (err: any) => {
          const stale = err?.status === 409;
          toast({
            title: stale ? "Document Updated" : "Error",
            description: stale
              ? "This document was updated since you opened it. It has been refreshed — please review the latest version and sign again."
              : "We couldn't save your signature. Please try again.",
            variant: "destructive",
          });
          if (stale) queryClient.invalidateQueries({ queryKey: getGetPublicSignoffQueryKey(token!) });
        },
      },
    );
  };

  return (
    <div className="min-h-[100dvh] bg-gray-100 text-black font-sans print:bg-white print:p-0">
      <div className="max-w-4xl mx-auto p-4 sm:p-8 print:p-0">
        <SignoffDocument
          quote={quote}
          revisions={revisions}
          signoff={signoff ?? null}
          onSubmit={submitSignoff}
        />
      </div>
    </div>
  );
}
