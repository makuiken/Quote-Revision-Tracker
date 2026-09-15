import { format } from "date-fns";
import type { ReactNode } from "react";

export type SignoffDocumentQuote = {
  quoteNumber: string;
  customerName?: string | null;
  projectName?: string | null;
  displayName?: string | null;
  jobAddress?: string | null;
  categories: string[];
  specs?: unknown;
};

export type SignoffDocumentRevision = {
  id?: number;
  createdAt: Date | string;
  authorName: string;
  note: string;
  categories?: string[] | null;
  excludedFromSignoff?: boolean | null;
};

export type SignoffDocumentSignoff = {
  customerName: string;
  stakeholderRole?: string | null;
  signatureType: "typed" | "drawn";
  signatureData: string;
  signedAt: Date | string;
};

export type SignoffDocumentProps = {
  quote: SignoffDocumentQuote;
  revisions: SignoffDocumentRevision[];
  signoff?: SignoffDocumentSignoff | null;
  hasManifest?: boolean;
  /** Omitted only for legacy whole-quote documents. Scoped data is server-filtered. */
  productTypes?: string[];
  notIncludedProductTypes?: string[];
  /** Locked preparation time for a scoped approval preview and its print view. */
  preparedAt?: string;
  /** A packet viewer in the browser, intentionally omitted by server PDF rendering. */
  packetSection?: ReactNode;
  /** Browser-only signer form. The print version never includes this node. */
  signingControls?: ReactNode;
  /** Internal browser-only revision exclusion controls. */
  renderRevisionControls?: (
    revision: SignoffDocumentRevision,
    excluded: boolean,
  ) => ReactNode;
  logoSrc?: string;
};

const CATEGORY_LABELS: Record<string, string> = {
  doors: "Doors (Legacy)",
  interiorDoors: "Interior Doors",
  exteriorDoors: "Exterior Doors",
  windows: "Windows",
  trim: "Moulding",
  millwork: "Millwork",
};

const categoryLabel = (id: string) => CATEGORY_LABELS[id] ?? id;

function capitalize(value: string): string {
  return value ? value.charAt(0).toUpperCase() + value.slice(1) : value;
}

function displayName(quote: SignoffDocumentQuote): string {
  if (quote.displayName) return quote.displayName;
  return quote.projectName
    ? `${quote.customerName ?? ""} - ${quote.projectName}`
    : (quote.customerName ?? "");
}

function specEntries(spec: unknown): Array<[string, unknown]> {
  if (!spec || typeof spec !== "object") return [];
  return Object.entries(spec as Record<string, unknown>).filter(([, value]) =>
    Boolean(value),
  );
}

function SpecSection({ title, spec }: { title: string; spec: unknown }) {
  const entries = specEntries(spec);
  return (
    <div className="border border-gray-300 p-4 rounded bg-gray-50/50">
      <h3 className="font-bold uppercase mb-2">{title}</h3>
      {entries.length > 0 ? (
        <ul className="text-sm space-y-1">
          {entries.map(([key, value]) => (
            <li key={key}>
              <span className="font-bold text-gray-600">
                {capitalize(key.replace(/([A-Z])/g, " $1").trim())}:
              </span>{" "}
              {capitalize(String(value))}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm italic text-gray-500">No specific details.</p>
      )}
    </div>
  );
}

function ApprovalScope({
  productTypes,
  notIncludedProductTypes,
}: {
  productTypes: string[];
  notIncludedProductTypes: string[];
}) {
  return (
    <div className="border-2 border-black bg-gray-50 p-4 break-inside-avoid">
      <h3 className="text-sm font-bold uppercase tracking-widest">
        Approval scope
      </h3>
      <p className="mt-1 text-sm">
        <strong>Included:</strong> {productTypes.map(categoryLabel).join(", ")}
      </p>
      {Boolean(notIncludedProductTypes.length) && (
        <p className="mt-1 text-sm text-gray-600">
          <strong>Not included:</strong>{" "}
          {notIncludedProductTypes.map(categoryLabel).join(", ")}
        </p>
      )}
      <p className="mt-2 text-xs text-gray-600">
        Shared terms and shared revisions shown in this document apply only to
        the included scope; they do not approve a product type listed as not
        included.
      </p>
    </div>
  );
}

function SignedMark() {
  return (
    <svg
      aria-hidden="true"
      className="w-16 h-16 text-green-700 mb-4"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
    >
      <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
      <path d="m9 11 3 3L22 4" />
    </svg>
  );
}

function RevisionLog({
  revisions,
  scopedTypes,
  renderRevisionControls,
}: Pick<SignoffDocumentProps, "revisions" | "renderRevisionControls"> & {
  scopedTypes: Set<string> | null;
}) {
  const includedRevisions = revisions.filter(
    (revision) =>
      !revision.excludedFromSignoff &&
      (!scopedTypes ||
        !revision.categories?.length ||
        revision.categories.some((type) => scopedTypes.has(type))),
  );
  if (!revisions.length) return null;

  return (
    <div className="mt-8">
      <h3 className="font-bold uppercase mb-4 text-sm tracking-widest text-gray-500">
        {scopedTypes ? "Relevant Revision Log" : "Complete Revision Log"} (
        {includedRevisions.length}{" "}
        {includedRevisions.length === 1 ? "update" : "updates"})
      </h3>
      {renderRevisionControls &&
        revisions.length !== includedRevisions.length && (
          <p className="print:hidden text-xs italic text-gray-500 mb-3">
            {revisions.length - includedRevisions.length} revision
            {revisions.length - includedRevisions.length === 1
              ? " is"
              : "s are"}{" "}
            hidden from this signoff document. They remain in the full revision
            log.
          </p>
        )}
      <div className="space-y-4 text-sm text-gray-700">
        {revisions.map((revision, index) => {
          const excluded = Boolean(revision.excludedFromSignoff);
          const unrelated =
            scopedTypes &&
            Boolean(revision.categories?.length) &&
            !revision.categories!.some((type) => scopedTypes.has(type));
          if (unrelated || (excluded && !renderRevisionControls)) return null;
          return (
            <div
              key={revision.id ?? `${revision.createdAt}-${index}`}
              className={`border border-gray-200 rounded p-3 break-inside-avoid ${
                excluded ? "print:hidden opacity-50 bg-gray-100" : "bg-white"
              }`}
            >
              <div className="flex items-start justify-between gap-3">
                <p className="font-bold text-gray-800">
                  {format(new Date(revision.createdAt), "MM/dd/yy h:mm a")} —{" "}
                  {revision.authorName}
                  {excluded && (
                    <span className="ml-2 text-xs font-bold uppercase tracking-wider text-gray-400">
                      Hidden from signoff
                    </span>
                  )}
                </p>
                {renderRevisionControls?.(revision, excluded)}
              </div>
              {Boolean(revision.categories?.length) && (
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {revision.categories!.map((tag) => (
                    <span
                      key={tag}
                      className="text-[10px] font-bold uppercase tracking-wider border border-gray-400 text-gray-600 rounded-full px-2 py-0.5"
                    >
                      {categoryLabel(tag)}
                    </span>
                  ))}
                </div>
              )}
              <p className="mt-1 whitespace-pre-wrap leading-relaxed">
                {revision.note}
              </p>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ApprovalSignature({
  signoff,
  signingControls,
}: Pick<SignoffDocumentProps, "signoff" | "signingControls">) {
  if (signoff) {
    return (
      <div className="bg-gray-50 border border-gray-200 p-6 rounded-lg text-center flex flex-col items-center">
        <SignedMark />
        <h3 className="text-2xl font-serif font-bold text-green-800 mb-2">
          Electronically Signed
        </h3>
        <p className="text-gray-600">
          By {signoff.customerName} · {signoff.stakeholderRole}
        </p>
        <p className="text-gray-600 mb-6">
          Signed{" "}
          {format(new Date(signoff.signedAt), "MMMM d, yyyy 'at' h:mm a")}
        </p>
        {signoff.signatureType === "drawn" ? (
          <div className="border-b-2 border-black inline-block px-12 pb-2">
            <img
              src={signoff.signatureData}
              alt="Customer Signature"
              className="h-24 object-contain mx-auto"
            />
          </div>
        ) : (
          <div className="border-b-2 border-black inline-block px-12 pb-2">
            <span className="font-serif text-3xl italic">
              {signoff.signatureData}
            </span>
          </div>
        )}
        <p className="text-sm font-bold text-gray-500 uppercase tracking-widest mt-2">
          Authorized Signature
        </p>
      </div>
    );
  }

  return (
    <div>
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
      <div className="print:hidden">{signingControls}</div>
    </div>
  );
}

/**
 * The presentation shared by the customer-facing SignoffDocument and the
 * server PDF renderer. Keep this component free of browser APIs so it can be
 * rendered to a standalone, offline HTML document with React SSR.
 */
export function SignoffDocumentPrint({
  quote,
  revisions,
  signoff,
  hasManifest = false,
  productTypes,
  notIncludedProductTypes = [],
  preparedAt,
  packetSection,
  signingControls,
  renderRevisionControls,
  logoSrc = "logo.png",
}: SignoffDocumentProps) {
  const scopedTypes = productTypes?.length ? new Set(productTypes) : null;
  const documentDate = preparedAt ? new Date(preparedAt) : null;
  const includedRevisions = revisions.filter(
    (revision) =>
      !revision.excludedFromSignoff &&
      (!scopedTypes ||
        !revision.categories?.length ||
        revision.categories.some((type) => scopedTypes.has(type))),
  );
  const activeCategories = quote.categories ?? [];
  const specs =
    quote.specs && typeof quote.specs === "object"
      ? (quote.specs as Record<string, unknown>)
      : {};
  const section = (type: string, title: string, value: unknown): ReactNode =>
    (!scopedTypes || scopedTypes.has(type)) &&
    activeCategories.includes(type) ? (
      <SpecSection title={title} spec={value} />
    ) : null;

  return (
    <div className="bg-white p-8 sm:p-12 shadow-lg print:shadow-none print:p-0 border border-gray-200 print:border-none">
      <div className="flex items-center justify-between border-b-4 border-black pb-6 mb-8">
        <img
          src={logoSrc}
          alt="Kuiken Brothers"
          className="h-20"
          style={{ filter: "grayscale(100%)" }}
        />
        <div className="text-right">
          <h1 className="text-2xl font-serif font-bold text-black uppercase tracking-widest">
            Signoff Document
          </h1>
          {documentDate ? (
            <p className="text-sm font-bold text-gray-600 mt-1">
              Prepared: {format(documentDate, "MMM d, yyyy")}
            </p>
          ) : (
            <p className="text-sm font-bold text-gray-600 mt-1 print:hidden">
              Current review copy
            </p>
          )}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-8 text-lg mb-8">
        <div>
          <p className="text-sm font-bold text-gray-500 uppercase tracking-widest mb-1">
            Quote Number
          </p>
          <p className="font-serif font-bold text-2xl">{quote.quoteNumber}</p>
        </div>
        <div>
          <p className="text-sm font-bold text-gray-500 uppercase tracking-widest mb-1">
            Customer / Project
          </p>
          <p className="font-serif font-bold text-2xl">{displayName(quote)}</p>
          <p className="text-gray-600 mt-1">{quote.jobAddress}</p>
        </div>
      </div>

      <div className="space-y-6 mb-12">
        <h2 className="text-xl font-bold uppercase tracking-widest border-b-2 border-black pb-2">
          Final Specifications
        </h2>
        <p className="text-sm italic text-gray-600 mb-4">
          By signing this document, you are approving the specifications exactly
          as detailed below. Any subsequent changes will require a new signoff.
        </p>
        {scopedTypes && (
          <ApprovalScope
            productTypes={productTypes!}
            notIncludedProductTypes={notIncludedProductTypes}
          />
        )}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
          {section("windows", "Windows", specs.window)}
          {section("interiorDoors", "Interior Doors", specs.interiorDoor)}
          {section("exteriorDoors", "Exterior Doors", specs.exteriorDoor)}
          {section("doors", "Doors", specs.door)}
          {(!scopedTypes || scopedTypes.has("trim")) &&
            activeCategories.includes("trim") && (
              <div className="border border-gray-300 p-4 rounded bg-gray-50/50">
                <h3 className="font-bold uppercase mb-2">Moulding</h3>
                <p className="text-sm whitespace-pre-wrap">
                  {capitalize(String(specs.trimDescription ?? "")) ||
                    "No specific details."}
                </p>
              </div>
            )}
          {(!scopedTypes || scopedTypes.has("millwork")) &&
            activeCategories.includes("millwork") && (
              <div className="border border-gray-300 p-4 rounded bg-gray-50/50">
                <h3 className="font-bold uppercase mb-2">Millwork</h3>
                <p className="text-sm whitespace-pre-wrap">
                  {capitalize(String(specs.millworkDescription ?? "")) ||
                    "No specific details."}
                </p>
              </div>
            )}
        </div>
        <RevisionLog
          revisions={revisions}
          scopedTypes={scopedTypes}
          renderRevisionControls={renderRevisionControls}
        />
      </div>

      {packetSection}

      <div className="mb-12 break-inside-avoid">
        <h2 className="text-xl font-bold uppercase tracking-widest border-b-2 border-black pb-2 mb-4">
          Terms &amp; Conditions
        </h2>
        <ul className="list-disc pl-6 text-sm space-y-2 text-gray-800">
          <li>
            It is the responsibility of the purchaser to ensure all
            measurements, colors, specifications, hardware, etc. are correct.
          </li>
          <li>
            Prior to Kuiken Brothers placing the order, a signature along with a
            50% deposit will be required.
          </li>
          <li>
            Cancellation or changes requested once the order has been submitted
            may not be possible and will incur additional fees.
          </li>
          <li>Units may not be returned for credit.</li>
          <li>
            Once received by Kuiken Brothers, windows stored for more than 2
            weeks will incur a storage fee.
          </li>
        </ul>
      </div>

      <div className="border-t-2 border-black pt-8 break-inside-avoid">
        <h2 className="text-xl font-bold uppercase tracking-widest mb-6">
          Customer Approval
        </h2>
        <p className="text-sm text-gray-700 mb-6 italic">
          I have reviewed all quoted line-item in detail and agree that the
          product specifications, unit handing, divided lite patterns, and
          pricing are accurate, and I approve the project for order. I
          acknowledge that additional charges, tax or Terms and Conditions may
          apply.
          {hasManifest
            ? " The approved manufacturer packet pages attached to this document are included as part of this approval."
            : ""}
        </p>
        <ApprovalSignature
          signoff={signoff}
          signingControls={signingControls}
        />
      </div>
    </div>
  );
}
