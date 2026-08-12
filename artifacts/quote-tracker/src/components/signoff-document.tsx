import { useState, useRef, useEffect } from "react";
import { format } from "date-fns";
import { CheckCircle, RefreshCcw } from "lucide-react";
import type { Quote, Revision, Signoff } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { categoryLabel } from "@/lib/revision-categories";

export function SignaturePad({ onSave, onClear }: { onSave: (data: string) => void, onClear: () => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [isDrawing, setIsDrawing] = useState(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // Scale for retina displays
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * window.devicePixelRatio;
    canvas.height = rect.height * window.devicePixelRatio;
    ctx.scale(window.devicePixelRatio, window.devicePixelRatio);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.lineWidth = 3;
    ctx.strokeStyle = "#000000";
  }, []);

  const getCoordinates = (e: React.MouseEvent | React.TouchEvent | MouseEvent | TouchEvent) => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    if ('touches' in e) {
      return {
        x: e.touches[0].clientX - rect.left,
        y: e.touches[0].clientY - rect.top
      };
    }
    return {
      x: (e as React.MouseEvent).clientX - rect.left,
      y: (e as React.MouseEvent).clientY - rect.top
    };
  };

  const startDrawing = (e: React.MouseEvent | React.TouchEvent) => {
    setIsDrawing(true);
    const { x, y } = getCoordinates(e);
    const ctx = canvasRef.current?.getContext("2d");
    if (ctx) {
      ctx.beginPath();
      ctx.moveTo(x, y);
    }
  };

  const draw = (e: React.MouseEvent | React.TouchEvent) => {
    if (!isDrawing) return;
    e.preventDefault(); // Prevent scrolling on touch
    const { x, y } = getCoordinates(e);
    const ctx = canvasRef.current?.getContext("2d");
    if (ctx) {
      ctx.lineTo(x, y);
      ctx.stroke();
    }
  };

  const stopDrawing = () => {
    setIsDrawing(false);
  };

  const handleClear = () => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (canvas && ctx) {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
    }
    onClear();
  };

  const handleSave = () => {
    const canvas = canvasRef.current;
    if (canvas) {
      onSave(canvas.toDataURL("image/png"));
    }
  };

  return (
    <div className="space-y-4">
      <div className="border-2 border-dashed border-gray-300 rounded-lg bg-gray-50 overflow-hidden relative">
        <canvas
          ref={canvasRef}
          onMouseDown={startDrawing}
          onMouseMove={draw}
          onMouseUp={stopDrawing}
          onMouseOut={stopDrawing}
          onTouchStart={startDrawing}
          onTouchMove={draw}
          onTouchEnd={stopDrawing}
          className="w-full h-[200px] cursor-crosshair touch-none"
        />
        <div className="absolute bottom-2 right-2 text-xs text-gray-400 font-bold uppercase tracking-widest pointer-events-none">
          Draw Signature Here
        </div>
      </div>
      <div className="flex gap-4">
        <Button type="button" variant="outline" onClick={handleClear} className="w-full">
          <RefreshCcw className="w-4 h-4 mr-2" /> Clear
        </Button>
        <Button type="button" onClick={handleSave} className="w-full bg-black text-white hover:bg-gray-800">
          Confirm Signature
        </Button>
      </div>
    </div>
  );
}

const capitalize = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

function SpecSection({ title, spec }: { title: string; spec: object | null | undefined }) {
  const entries = spec ? Object.entries(spec).filter(([_, v]) => v) : [];
  return (
    <div className="border border-gray-300 p-4 rounded bg-gray-50/50">
      <h3 className="font-bold uppercase mb-2">{title}</h3>
      {entries.length > 0 ? (
        <ul className="text-sm space-y-1">
          {entries.map(([k, v]) => (
            <li key={k}>
              <span className="font-bold text-gray-600">{capitalize(k.replace(/([A-Z])/g, ' $1').trim())}:</span> {capitalize(String(v))}
            </li>
          ))}
        </ul>
      ) : <p className="text-sm italic text-gray-500">No specific details.</p>}
    </div>
  );
}

export function SignoffDocument({
  quote,
  revisions,
  signoff,
  onSubmit,
  onToggleExclude,
}: {
  quote: Quote;
  revisions: Revision[];
  signoff: Signoff | null;
  onSubmit: (type: "typed" | "drawn", data: string) => void;
  /** When provided (internal view), shows hide/show controls per revision. */
  onToggleExclude?: (revision: Revision) => void;
}) {
  const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");
  const [signMethod, setSignMethod] = useState<"draw" | "type">("draw");
  const [typedName, setTypedName] = useState("");
  const [nameError, setNameError] = useState(false);

  const handleSaveTyped = () => {
    if (!typedName.trim()) {
      setNameError(true);
      return;
    }
    setNameError(false);
    onSubmit("typed", typedName);
  };

  return (
    <div className="bg-white p-8 sm:p-12 shadow-lg print:shadow-none print:p-0 border border-gray-200 print:border-none">
      <div className="flex items-center justify-between border-b-4 border-black pb-6 mb-8">
        <img src={`${basePath}/logo.png`} alt="Kuiken Brothers" className="h-20" style={{ filter: 'grayscale(100%)' }} />
        <div className="text-right">
          <h1 className="text-2xl font-serif font-bold text-black uppercase tracking-widest">Signoff Document</h1>
          <p className="text-sm font-bold text-gray-600 mt-1">Generated: {format(new Date(), "MMM d, yyyy")}</p>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-8 text-lg mb-8">
        <div>
          <p className="text-sm font-bold text-gray-500 uppercase tracking-widest mb-1">Quote Number</p>
          <p className="font-serif font-bold text-2xl">{quote.quoteNumber}</p>
        </div>
        <div>
          <p className="text-sm font-bold text-gray-500 uppercase tracking-widest mb-1">Customer / Project</p>
          <p className="font-serif font-bold text-2xl">{quote.displayName}</p>
          <p className="text-gray-600 mt-1">{quote.jobAddress}</p>
        </div>
      </div>

      <div className="space-y-6 mb-12">
        <h2 className="text-xl font-bold uppercase tracking-widest border-b-2 border-black pb-2">Final Specifications</h2>
        <p className="text-sm italic text-gray-600 mb-4">By signing this document, you are approving the specifications exactly as detailed below. Any subsequent changes will require a new signoff.</p>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
          {quote.categories.includes("windows") && (
            <SpecSection title="Windows" spec={quote.specs?.window} />
          )}
          {quote.categories.includes("interiorDoors") && (
            <SpecSection title="Interior Doors" spec={quote.specs?.interiorDoor} />
          )}
          {quote.categories.includes("exteriorDoors") && (
            <SpecSection title="Exterior Doors" spec={quote.specs?.exteriorDoor} />
          )}
          {quote.categories.includes("doors") && (
            <SpecSection title="Doors" spec={quote.specs?.door} />
          )}
          {quote.categories.includes("trim") && (
            <div className="border border-gray-300 p-4 rounded bg-gray-50/50">
              <h3 className="font-bold uppercase mb-2">Trim</h3>
              <p className="text-sm whitespace-pre-wrap">{capitalize(quote.specs?.trimDescription || "") || "No specific details."}</p>
            </div>
          )}
          {quote.categories.includes("millwork") && (
            <div className="border border-gray-300 p-4 rounded bg-gray-50/50">
              <h3 className="font-bold uppercase mb-2">Millwork</h3>
              <p className="text-sm whitespace-pre-wrap">{capitalize(quote.specs?.millworkDescription || "") || "No specific details."}</p>
            </div>
          )}
        </div>

        {revisions.length > 0 && (() => {
          const included = revisions.filter(rev => !rev.excludedFromSignoff);
          return (
            <div className="mt-8">
              <h3 className="font-bold uppercase mb-4 text-sm tracking-widest text-gray-500">
                Complete Revision Log ({included.length} {included.length === 1 ? "update" : "updates"})
              </h3>
              {onToggleExclude && revisions.length !== included.length && (
                <p className="print:hidden text-xs italic text-gray-500 mb-3">
                  {revisions.length - included.length} revision{revisions.length - included.length === 1 ? " is" : "s are"} hidden from this signoff document. They remain in the full revision log.
                </p>
              )}
              <div className="space-y-4 text-sm text-gray-700">
                {revisions.map(rev => {
                  const excluded = rev.excludedFromSignoff;
                  if (excluded && !onToggleExclude) return null;
                  return (
                    <div
                      key={rev.id}
                      className={`border border-gray-200 rounded p-3 break-inside-avoid ${excluded ? "print:hidden opacity-50 bg-gray-100" : "bg-white"}`}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <p className="font-bold text-gray-800">
                          {format(new Date(rev.createdAt), "MM/dd/yy h:mm a")} — {rev.authorName}
                          {excluded && <span className="ml-2 text-xs font-bold uppercase tracking-wider text-gray-400">Hidden from signoff</span>}
                        </p>
                        {onToggleExclude && (
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            className="print:hidden shrink-0 h-7 text-xs"
                            onClick={() => onToggleExclude(rev)}
                          >
                            {excluded ? "Include on Signoff" : "Hide from Signoff"}
                          </Button>
                        )}
                      </div>
                      {(rev.categories?.length ?? 0) > 0 && (
                        <div className="mt-1.5 flex flex-wrap gap-1.5">
                          {rev.categories!.map((tag) => (
                            <span
                              key={tag}
                              className="text-[10px] font-bold uppercase tracking-wider border border-gray-400 text-gray-600 rounded-full px-2 py-0.5"
                            >
                              {categoryLabel(tag)}
                            </span>
                          ))}
                        </div>
                      )}
                      <p className="mt-1 whitespace-pre-wrap leading-relaxed">{rev.note}</p>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })()}
      </div>

      <div className="mb-12 break-inside-avoid">
        <h2 className="text-xl font-bold uppercase tracking-widest border-b-2 border-black pb-2 mb-4">Terms &amp; Conditions</h2>
        <ul className="list-disc pl-6 text-sm space-y-2 text-gray-800">
          <li>It is the responsibility of the purchaser to ensure all measurements, colors, specifications, hardware, etc. are correct.</li>
          <li>Prior to Kuiken Brothers placing the order, a signature along with a 50% deposit will be required.</li>
          <li>Cancellation or changes requested once the order has been submitted may not be possible and will incur additional fees.</li>
          <li>Units may not be returned for credit.</li>
          <li>Once received by Kuiken Brothers, windows stored for more than 2 weeks will incur a storage fee.</li>
        </ul>
      </div>

      <div className="border-t-2 border-black pt-8 break-inside-avoid">
        <h2 className="text-xl font-bold uppercase tracking-widest mb-6">Customer Approval</h2>

        <p className="text-sm text-gray-700 mb-6 italic">
          I have reviewed all quoted line-item in detail and agree that the product specifications, unit handing, divided lite patterns, and pricing are accurate, and I approve the project for order. I acknowledge that additional charges, tax or Terms and Conditions may apply.
        </p>

        {quote.signed && signoff ? (
          <div className="bg-gray-50 border border-gray-200 p-6 rounded-lg text-center flex flex-col items-center">
            <CheckCircle className="w-16 h-16 text-green-700 mb-4" />
            <h3 className="text-2xl font-serif font-bold text-green-800 mb-2">Electronically Signed</h3>
            <p className="text-gray-600 mb-6">By {signoff.customerName} on {format(new Date(signoff.signedAt), "MMMM d, yyyy 'at' h:mm a")}</p>

            {signoff.signatureType === "drawn" ? (
              <div className="border-b-2 border-black inline-block px-12 pb-2">
                <img src={signoff.signatureData} alt="Customer Signature" className="h-24 object-contain mx-auto" />
              </div>
            ) : (
              <div className="border-b-2 border-black inline-block px-12 pb-2">
                <span className="font-serif text-3xl italic">{signoff.signatureData}</span>
              </div>
            )}
            <p className="text-sm font-bold text-gray-500 uppercase tracking-widest mt-2">Authorized Signature</p>
          </div>
        ) : (
          <div>
            {/* Print version of signature line (always visible on paper) */}
            <div className="hidden print:block space-y-16">
              <div className="flex items-end gap-4">
                <div className="w-16 text-lg font-bold">X</div>
                <div className="flex-1 border-b-2 border-black pt-12"></div>
                <div className="w-32 border-b-2 border-black pt-12"></div>
              </div>
              <div className="flex gap-4 text-sm font-bold text-gray-500 uppercase tracking-widest">
                <div className="w-16"></div>
                <div className="flex-1">Authorized Signature</div>
                <div className="w-32 text-center">Date</div>
              </div>
            </div>

            {/* Digital Signing UI (hidden on print) */}
            <div className="print:hidden bg-gray-50 border border-gray-200 p-6 sm:p-8 rounded-lg">
              <div className="flex gap-4 mb-6">
                <Button
                  variant={signMethod === "draw" ? "default" : "outline"}
                  onClick={() => setSignMethod("draw")}
                  className={signMethod === "draw" ? "bg-black text-white" : ""}
                >
                  Draw Signature
                </Button>
                <Button
                  variant={signMethod === "type" ? "default" : "outline"}
                  onClick={() => setSignMethod("type")}
                  className={signMethod === "type" ? "bg-black text-white" : ""}
                >
                  Type Name
                </Button>
              </div>

              {signMethod === "draw" ? (
                <SignaturePad onSave={(dataUrl) => onSubmit("drawn", dataUrl)} onClear={() => {}} />
              ) : (
                <div className="space-y-4">
                  <div className="space-y-2">
                    <Label htmlFor="typedName">Type your full legal name</Label>
                    <Input
                      id="typedName"
                      value={typedName}
                      onChange={(e) => { setTypedName(e.target.value); setNameError(false); }}
                      placeholder="e.g. John Doe"
                      className="font-serif text-2xl italic h-14 bg-white border-2 border-gray-300"
                    />
                    {nameError && (
                      <p className="text-sm text-red-600 font-medium">Please type your full name to sign.</p>
                    )}
                  </div>
                  <Button onClick={handleSaveTyped} className="w-full bg-black text-white hover:bg-gray-800">
                    Confirm Signature
                  </Button>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
