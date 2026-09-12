/**
 * Shared boundary between packet orchestration and the PDF engine.
 * Coordinates are PDF points measured from the top-left of a page.
 */
export type PacketStatus =
  | "awaiting_upload"
  | "queued"
  | "processing"
  | "needs_review"
  | "ready_for_approval"
  | "approved"
  | "failed";

export type PacketPageType =
  | "cover"
  | "quote"
  | "pricing"
  | "specification"
  | "warranty"
  | "terms"
  | "other";

export type RedactionRect = {
  x: number;
  y: number;
  width: number;
  height: number;
  reason?: string;
};

export type PacketPageAnalysis = {
  pageNumber: number;
  width: number;
  height: number;
  pageType: PacketPageType;
  suggestedRects: RedactionRect[];
};

export type PacketAnalysis = {
  pages: PacketPageAnalysis[];
};

export type SanitizedPacketPage = {
  pageNumber: number;
  width: number;
  height: number;
  pngBytes: Uint8Array;
};

export type SanitizedPacket = {
  pdfBytes: Uint8Array;
  pages: SanitizedPacketPage[];
};

export type PacketEngine = {
  analyzePdf(
    bytes: Uint8Array,
    manufacturer?: string | null,
  ): Promise<PacketAnalysis>;
  generateSanitizedPacket(input: {
    bytes: Uint8Array;
    manufacturer?: string | null;
    redactionsByPage: Record<number, RedactionRect[]>;
  }): Promise<SanitizedPacket>;
};

export type PacketSummary = {
  id: number;
  quoteId: number;
  manufacturer: string | null;
  detectedManufacturer?: string | null;
  originalName: string;
  status: PacketStatus;
  pageCount: number | null;
  failureMessage: string | null;
  createdAt: Date;
  updatedAt: Date;
  approvedAt: Date | null;
};