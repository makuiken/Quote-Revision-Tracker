import { useState, useRef, useEffect, useId } from "react";
import { RefreshCcw } from "lucide-react";
import type { Quote, Revision, Signoff } from "@workspace/api-client-react";
import { SignoffDocumentPrint } from "@workspace/signoff-document";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

type SignoffDocumentQuote = Pick<
  Quote,
  "quoteNumber" | "displayName" | "jobAddress" | "categories" | "specs"
>;

export function SignaturePad({ onSave, onClear, isSubmitting }: { onSave: (data: string) => void, onClear: () => void, isSubmitting?: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const instructionsId = useId();
  const errorId = useId();
  const [isDrawing, setIsDrawing] = useState(false);
  const [hasInk, setHasInk] = useState(false);
  const [showError, setShowError] = useState(false);

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
      setHasInk(true);
      setShowError(false);
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
    setHasInk(false);
    setShowError(false);
  };

  const handleSave = () => {
    if (!hasInk) {
      setShowError(true);
      return;
    }
    const canvas = canvasRef.current;
    if (canvas) {
      onSave(canvas.toDataURL("image/png"));
    }
  };

  return (
    <div className="space-y-4">
      <p id={instructionsId} className="text-sm text-gray-700">
        Draw inside the box with a mouse, pen, or touch. If drawing is not accessible to you, choose <strong>Type Signature</strong>.
      </p>
      <div className="border-2 border-dashed border-gray-300 rounded-lg bg-gray-50 overflow-hidden relative">
        <canvas
          ref={canvasRef}
          aria-label="Draw your signature"
          aria-describedby={`${instructionsId}${showError ? ` ${errorId}` : ""}`}
          aria-invalid={showError}
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
      {showError && (
        <p id={errorId} className="text-sm text-red-600 font-medium" role="alert">
          Please draw your signature before confirming.
        </p>
      )}
      <div className="flex gap-4">
        <Button type="button" variant="outline" onClick={handleClear} disabled={isSubmitting} className="w-full">
          <RefreshCcw className="w-4 h-4 mr-2" /> Clear
        </Button>
        <Button type="button" onClick={handleSave} disabled={isSubmitting} className="w-full bg-black text-white hover:bg-gray-800">
          {isSubmitting ? "Recording signature…" : "Confirm Signature"}
        </Button>
      </div>
    </div>
  );
}

export function SignoffDocument({
  quote,
  revisions,
  signoff,
  onSubmit,
  onToggleExclude,
  packetSection,
  hasManifest,
  disabledReason,
  isSubmitting,
  productTypes,
  notIncludedProductTypes,
  isSigned,
  preparedAt,
}: {
  quote: SignoffDocumentQuote;
  revisions: Revision[];
  signoff: Signoff | null;
  onSubmit: (
    signerName: string,
    stakeholderRole: "Homeowner" | "Contractor" | "Architect/Designer" | "Other",
    type: "typed" | "drawn",
    data: string,
  ) => void;
  /** When provided (internal view), shows hide/show controls per revision. */
  onToggleExclude?: (revision: Revision) => void;
  hasManifest?: boolean;
  packetSection?: React.ReactNode;
  disabledReason?: string;
  isSubmitting?: boolean;
  /** Omitted only for legacy whole-quote documents. Scoped data is server-filtered. */
  productTypes?: string[];
  notIncludedProductTypes?: string[];
  /** Scoped approvals can be signed while the rest of a quote remains open. */
  isSigned?: boolean;
  /** Locked preparation time for a scoped approval preview and its print view. */
  preparedAt?: string;
}) {
  const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");
  const [signMethod, setSignMethod] = useState<"draw" | "type">("draw");
  const [signerName, setSignerName] = useState("");
  const [stakeholderRole, setStakeholderRole] = useState<
    "Homeowner" | "Contractor" | "Architect/Designer" | "Other" | ""
  >("");
  const [nameError, setNameError] = useState(false);
  const [roleError, setRoleError] = useState(false);
  const nameErrorId = useId();
  const roleErrorId = useId();
  const signed = isSigned ?? false;

  const validateIdentity = () => {
    const validName = Boolean(signerName.trim());
    const validRole = Boolean(stakeholderRole);
    setNameError(!validName);
    setRoleError(!validRole);
    return validName && validRole;
  };

  const handleSaveTyped = () => {
    if (!validateIdentity()) {
      setNameError(true);
      return;
    }
    setNameError(false);
    onSubmit(
      signerName.trim(),
      stakeholderRole as "Homeowner" | "Contractor" | "Architect/Designer" | "Other",
      "typed",
      signerName.trim(),
    );
  };

  const handleSaveDrawn = (dataUrl: string) => {
    if (!validateIdentity()) return;
    onSubmit(
      signerName.trim(),
      stakeholderRole as "Homeowner" | "Contractor" | "Architect/Designer" | "Other",
      "drawn",
      dataUrl,
    );
  };

  const signingControls = signed ? null : (
    <div className="bg-gray-50 border border-gray-200 p-6 sm:p-8 rounded-lg">
      {disabledReason ? (
        <div className="bg-red-50 border border-red-200 text-red-800 p-4 rounded text-sm font-medium">
          Cannot sign: {disabledReason}
        </div>
      ) : (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-6">
            <div className="space-y-2">
              <Label htmlFor="signerName">Your full legal name</Label>
              <Input
                id="signerName"
                value={signerName}
                onChange={(e) => {
                  setSignerName(e.target.value);
                  setNameError(false);
                }}
                placeholder="e.g. John Doe"
                autoComplete="name"
                aria-invalid={nameError}
                aria-describedby={nameError ? nameErrorId : undefined}
                className="bg-white border-2 border-gray-300"
              />
              {nameError && (
                <p id={nameErrorId} className="text-sm text-red-600 font-medium" role="alert">
                  Please enter your full name.
                </p>
              )}
            </div>
            <div className="space-y-2">
              <Label htmlFor="stakeholderRole">Your role</Label>
              <Select
                value={stakeholderRole}
                onValueChange={(value) => {
                  setStakeholderRole(
                    value as "Homeowner" | "Contractor" | "Architect/Designer" | "Other",
                  );
                  setRoleError(false);
                }}
              >
                <SelectTrigger
                  id="stakeholderRole"
                  data-testid="stakeholder-role"
                  aria-invalid={roleError}
                  aria-describedby={roleError ? roleErrorId : undefined}
                >
                  <SelectValue placeholder="Select your role" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="Homeowner">Homeowner</SelectItem>
                  <SelectItem value="Contractor">Contractor</SelectItem>
                  <SelectItem value="Architect/Designer">Architect/Designer</SelectItem>
                  <SelectItem value="Other">Other</SelectItem>
                </SelectContent>
              </Select>
              {roleError && (
                <p id={roleErrorId} className="text-sm text-red-600 font-medium" role="alert">
                  Please select your role.
                </p>
              )}
            </div>
          </div>

          <div className="flex gap-4 mb-6" role="radiogroup" aria-label="Signature method">
            <Button
              type="button"
              role="radio"
              aria-checked={signMethod === "draw"}
              variant={signMethod === "draw" ? "default" : "outline"}
              onClick={() => setSignMethod("draw")}
              className={signMethod === "draw" ? "bg-black text-white" : ""}
            >
              Draw Signature
            </Button>
            <Button
              type="button"
              role="radio"
              aria-checked={signMethod === "type"}
              variant={signMethod === "type" ? "default" : "outline"}
              onClick={() => setSignMethod("type")}
              className={signMethod === "type" ? "bg-black text-white" : ""}
            >
              Type Signature
            </Button>
          </div>

          {signMethod === "draw" ? (
            <SignaturePad
              onSave={handleSaveDrawn}
              onClear={() => {}}
              isSubmitting={isSubmitting}
            />
          ) : (
            <div className="space-y-4">
              <div className="border border-gray-300 rounded-lg bg-white p-5 text-center">
                <p className="text-xs font-bold uppercase tracking-widest text-gray-500 mb-3">
                  Signature preview
                </p>
                <p className="font-serif text-3xl italic min-h-10">
                  {signerName.trim() || "Your name will appear here"}
                </p>
              </div>
              <Button
                type="button"
                onClick={handleSaveTyped}
                disabled={isSubmitting}
                className="w-full bg-black text-white hover:bg-gray-800"
              >
                {isSubmitting ? "Recording signature…" : "Confirm Signature"}
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );

  return (
    <SignoffDocumentPrint
      quote={quote}
      revisions={revisions}
      signoff={signoff}
      hasManifest={hasManifest}
      productTypes={productTypes}
      notIncludedProductTypes={notIncludedProductTypes}
      preparedAt={preparedAt}
      packetSection={packetSection}
      signingControls={signingControls}
      logoSrc={`${basePath}/logo.png`}
      renderRevisionControls={
        onToggleExclude
          ? (revision, excluded) => (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="print:hidden shrink-0 h-7 text-xs"
                onClick={() => onToggleExclude(revision as Revision)}
              >
                {excluded ? "Include on Signoff" : "Hide from Signoff"}
              </Button>
            )
          : undefined
      }
    />
  );
}
