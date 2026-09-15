import { format } from "date-fns";
import { CheckCircle, AlertTriangle, FileText } from "lucide-react";
import type { SignoffReceipt } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

export function SignoffReceiptView({ receipt }: { receipt: SignoffReceipt }) {
  const isCurrent = receipt.status === "current";
  const signedDate = format(new Date(receipt.signedAt), "MMMM d, yyyy 'at' h:mm a");
  const scopeLabels: Record<string, string> = {
    windows: "Windows",
    interiorDoors: "Interior Doors",
    exteriorDoors: "Exterior Doors",
    doors: "Doors",
    trim: "Moulding",
    millwork: "Millwork",
    "legacy whole quote": "Legacy whole quote",
  };

  return (
    <Card
      className={`border-2 shadow-lg mb-8 ${isCurrent ? "border-green-200 bg-green-50/30" : "border-amber-200 bg-amber-50/30"}`}
      role="status"
      aria-live="polite"
    >
      <CardContent className="p-8 sm:p-10 flex flex-col items-center text-center">
        {isCurrent ? (
          <CheckCircle className="w-16 h-16 text-green-600 mb-6" />
        ) : (
          <AlertTriangle className="w-16 h-16 text-amber-500 mb-6" />
        )}
        
        <h2 className="text-3xl font-serif font-bold text-gray-900 mb-2">
          {isCurrent ? "Approval Recorded" : "Approval Outdated"}
        </h2>
        
        <p className="text-gray-600 text-lg mb-8 max-w-xl">
          By <strong>{receipt.signerName}</strong> ({receipt.signerRole}) on {signedDate}
        </p>

        <div className="w-full max-w-2xl bg-white border border-gray-200 rounded-lg p-6 mb-8 text-left space-y-4">
          <div className="flex justify-between items-end border-b border-gray-100 pb-4">
            <div>
              <p className="text-xs font-bold text-gray-500 uppercase tracking-widest">Quote Reference</p>
              <p className="font-serif font-bold text-xl text-gray-900 mt-1">#{receipt.quoteNumber}</p>
            </div>
            <div className="text-right">
              <p className="text-xs font-bold text-gray-500 uppercase tracking-widest">Scope</p>
              <p className="font-medium text-gray-900 mt-1">
                {receipt.approvalScope.map((scope) => scopeLabels[scope] ?? scope).join(", ")}
              </p>
            </div>
          </div>

          {!isCurrent && (
            <div className="pt-2">
              <p className="text-sm font-bold text-amber-800 uppercase tracking-widest mb-1">Status</p>
              <p className="text-sm text-amber-900 leading-relaxed">
                This approval is no longer current and requires re-signing.
                {receipt.reason && <span className="block mt-1"><strong>Reason:</strong> {receipt.reason}</span>}
              </p>
            </div>
          )}
        </div>

        {receipt.signedDocumentAvailable && receipt.signedDocumentPath ? (
          <div className="space-y-3 w-full max-w-sm">
            <Button asChild className="w-full h-12 text-base font-bold bg-black text-white hover:bg-gray-800">
              <a href={`/api${receipt.signedDocumentPath}`} target="_blank" rel="noreferrer">
                <FileText className="w-5 h-5 mr-2" />
                Open Signed Document
              </a>
            </Button>
            <p className="text-xs text-gray-500 font-medium px-4">
              This immutable PDF is your evidence of approval. The current live quote may have changed since signing.
            </p>
          </div>
        ) : (
          <div className="text-sm text-gray-500 bg-gray-100 p-4 rounded-md w-full max-w-md border border-gray-200">
            <p className="font-bold mb-1">Signed document unavailable</p>
            <p>The original signed PDF for this historical approval cannot be retrieved.</p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
