import { inflateRawSync } from "node:zlib";
import { PDFDocument } from "pdf-lib";

export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const ZIP_MAX_ENTRY_BYTES = 50 * 1024 * 1024;
const ZIP_MAX_UNCOMPRESSED_BYTES = 100 * 1024 * 1024;

type AttachmentFormat =
  | "pdf"
  | "jpeg"
  | "png"
  | "gif"
  | "webp"
  | "heic"
  | "tiff"
  | "ole"
  | "docx"
  | "xlsx"
  | "dwg"
  | "dxf";

export function normalizeAttachmentContentType(value: string): string {
  return value.split(";", 1)[0]!.trim().toLowerCase();
}

export function attachmentFilenameMatchesContentType(
  name: string,
  contentType: string,
): boolean {
  const extension = name.trim().split(".").pop()?.toLowerCase() ?? "";
  const normalizedType = normalizeAttachmentContentType(contentType);
  if (normalizedType === "application/octet-stream") {
    return extension === "dwg" || extension === "dxf";
  }
  const allowedExtensions: Record<string, ReadonlySet<string>> = {
    "application/pdf": new Set(["pdf"]),
    "image/jpeg": new Set(["jpg", "jpeg"]),
    "image/png": new Set(["png"]),
    "image/gif": new Set(["gif"]),
    "image/webp": new Set(["webp"]),
    "image/heic": new Set(["heic"]),
    "image/heif": new Set(["heif"]),
    "image/tiff": new Set(["tif", "tiff"]),
    "application/msword": new Set(["doc"]),
    "application/vnd.ms-excel": new Set(["xls"]),
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
      new Set(["docx"]),
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet":
      new Set(["xlsx"]),
    "application/acad": new Set(["dwg"]),
    "application/x-acad": new Set(["dwg"]),
    "application/autocad_dwg": new Set(["dwg"]),
    "image/vnd.dwg": new Set(["dwg"]),
    "image/x-dwg": new Set(["dwg"]),
    "application/dxf": new Set(["dxf"]),
    "application/x-dxf": new Set(["dxf"]),
    "image/vnd.dxf": new Set(["dxf"]),
  };
  return allowedExtensions[normalizedType]?.has(extension) ?? false;
}

/**
 * Validate the bytes from the generation that is about to be attached.
 *
 * Metadata supplied to the presigned PUT is not a content validator: a
 * caller can upload a valid-looking name and content type around arbitrary
 * bytes. This intentionally performs format-specific, bounded parsing rather
 * than attempting malware detection. Unsupported legacy formats are kept
 * behind conservative container/header checks so existing CAD and Office
 * attachments remain usable without introducing another dependency.
 */
export async function validateAttachmentBytes(
  name: string,
  contentType: string,
  bytes: Buffer,
): Promise<string | null> {
  const format = attachmentFormat(name, contentType);
  if (!format) return "This file type is not supported for content validation.";
  if (!attachmentFilenameMatchesContentType(name, contentType)) {
    return "The file name extension does not match its declared content type.";
  }
  if (bytes.length < 1 || bytes.length > MAX_ATTACHMENT_BYTES) {
    return "The uploaded file is empty or exceeds the allowed size.";
  }

  try {
    switch (format) {
      case "pdf":
        return (await isValidPdf(bytes))
          ? null
          : "The uploaded PDF is malformed or does not match its declared type.";
      case "jpeg":
      case "png":
      case "gif":
      case "webp":
        return (await isValidRasterImage(format, bytes))
          ? null
          : "The uploaded image is malformed or does not match its declared type.";
      case "heic":
        return isValidHeif(bytes)
          ? null
          : "The uploaded HEIC/HEIF image is malformed or does not match its declared type.";
      case "tiff":
        return isValidTiff(bytes)
          ? null
          : "The uploaded TIFF image is malformed or does not match its declared type.";
      case "docx":
        return isValidOfficeZip(bytes, "word/document.xml", "word")
          ? null
          : "The uploaded Word document is malformed or does not match its declared type.";
      case "xlsx":
        return isValidOfficeZip(bytes, "xl/workbook.xml", "xl")
          ? null
          : "The uploaded Excel workbook is malformed or does not match its declared type.";
      case "ole":
        return isValidCompoundFile(bytes)
          ? null
          : "The uploaded Office document is malformed or does not match its declared type.";
      case "dwg":
        return isValidDwg(bytes)
          ? null
          : "The uploaded DWG drawing is malformed or does not match its declared type.";
      case "dxf":
        return isValidDxf(bytes)
          ? null
          : "The uploaded DXF drawing is malformed or does not match its declared type.";
    }
  } catch {
    return "The uploaded file is malformed or could not be safely parsed.";
  }
}

/**
 * Returns a header-safe attachment disposition. The ASCII fallback is kept
 * deliberately boring because it is sent before a browser sees the bytes.
 */
export function attachmentContentDisposition(name: string): string {
  const cleaned = name
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[\\/]/g, "_")
    .replace(/"/g, "'")
    .trim();
  const safeName = cleaned || "download";
  const asciiName =
    safeName.replace(/[^\x20-\x7e]/g, "_").slice(0, 180) || "download";
  const encodedName = encodeURIComponent(safeName).replace(
    /['()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${asciiName}"; filename*=UTF-8''${encodedName}`;
}

function attachmentFormat(name: string, contentType: string): AttachmentFormat | null {
  const normalizedType = normalizeAttachmentContentType(contentType);
  if (normalizedType === "application/octet-stream") {
    const extension = name.trim().split(".").pop()?.toLowerCase();
    return extension === "dwg" || extension === "dxf" ? extension : null;
  }
  const byContentType: Record<string, AttachmentFormat> = {
    "application/pdf": "pdf",
    "image/jpeg": "jpeg",
    "image/png": "png",
    "image/gif": "gif",
    "image/webp": "webp",
    "image/heic": "heic",
    "image/heif": "heic",
    "image/tiff": "tiff",
    "application/msword": "ole",
    "application/vnd.ms-excel": "ole",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
    "application/acad": "dwg",
    "application/x-acad": "dwg",
    "application/autocad_dwg": "dwg",
    "image/vnd.dwg": "dwg",
    "image/x-dwg": "dwg",
    "application/dxf": "dxf",
    "application/x-dxf": "dxf",
    "image/vnd.dxf": "dxf",
  };
  return byContentType[normalizedType] ?? null;
}

async function isValidPdf(bytes: Buffer): Promise<boolean> {
  if (!bytes.subarray(0, 5).equals(Buffer.from("%PDF-"))) return false;
  const pdfjs = (await import("pdfjs-dist/legacy/build/pdf.mjs")) as unknown as {
    getDocument: (options: {
      data: Uint8Array;
      disableWorker: boolean;
      isEvalSupported: boolean;
      stopAtErrors: boolean;
    }) => {
      promise: Promise<{
        numPages: number;
        cleanup: () => Promise<void>;
        getJSActions: () => Promise<unknown>;
        getAttachments: () => Promise<unknown>;
        getOpenAction: () => Promise<unknown>;
        getPage: (pageNumber: number) => Promise<{
          getJSActions: () => Promise<unknown>;
          getAnnotations: () => Promise<unknown[]>;
        }>;
      }>;
      destroy?: () => Promise<void>;
    };
  };
  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(bytes),
    disableWorker: true,
    isEvalSupported: false,
    stopAtErrors: true,
  });
  let document:
    | {
        numPages: number;
        cleanup: () => Promise<void>;
        getJSActions: () => Promise<unknown>;
        getAttachments: () => Promise<unknown>;
        getOpenAction: () => Promise<unknown>;
        getPage: (pageNumber: number) => Promise<{
          getJSActions: () => Promise<unknown>;
          getAnnotations: () => Promise<unknown[]>;
        }>;
      }
    | undefined;
  try {
    document = await loadingTask.promise;
    if (!Number.isInteger(document.numPages) || document.numPages < 1) {
      return false;
    }
    const [documentJSActions, attachments, openAction] = await Promise.all([
      document.getJSActions(),
      document.getAttachments(),
      document.getOpenAction(),
    ]);
    if (
      hasEntries(documentJSActions) ||
      hasEntries(attachments) ||
      hasLaunchAction(openAction) ||
      hasPdfLaunchAction(bytes)
    ) {
      return false;
    }
    if (await hasUnsafePdfObjects(bytes)) return false;
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const [pageJSActions, annotations] = await Promise.all([
        page.getJSActions(),
        page.getAnnotations(),
      ]);
      if (
        hasEntries(pageJSActions) ||
        annotations.some(
          (annotation) =>
            hasLaunchAction(annotation) ||
            hasEmbeddedFileAnnotation(annotation) ||
            hasEntries((annotation as { actions?: unknown }).actions),
        )
      ) {
        return false;
      }
    }
    return true;
  } finally {
    if (document) {
      await document.cleanup();
    }
    await loadingTask.destroy?.();
  }
}

function hasEntries(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (value instanceof Map || value instanceof Set) return value.size > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return false;
}

function hasLaunchAction(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (value instanceof Map) {
    const action = value.get("action");
    if (typeof action === "string" && action.toLowerCase() === "launch") {
      return true;
    }
    return [...value.values()].some((entry) => hasLaunchAction(entry));
  }
  if (Array.isArray(value)) return value.some((entry) => hasLaunchAction(entry));
  if (typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  if (
    typeof record.action === "string" &&
    record.action.toLowerCase() === "launch"
  ) {
    return true;
  }
  return hasLaunchAction(record.action);
}

function hasEmbeddedFileAnnotation(value: unknown): boolean {
  if (value === null || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    record.annotationType === 17 ||
    record.subtype === "FileAttachment" ||
    record.file !== undefined ||
    record.attachment !== undefined
  );
}

function hasPdfLaunchAction(bytes: Buffer): boolean {
  return /\/S\s*\/Launch(?:\s|[/>])/.test(bytes.toString("latin1"));
}

async function hasUnsafePdfObjects(bytes: Buffer): Promise<boolean> {
  const document = await PDFDocument.load(bytes);
  const serializedObjects = document.context
    .enumerateIndirectObjects()
    .map(([, object]) => object.toString())
    .join("\n");
  return (
    /\/S\s*\/(?:JavaScript|Launch)(?:\s|[/>])/.test(serializedObjects) ||
    /\/EmbeddedFiles(?:\s|[/>])/.test(serializedObjects) ||
    /\/Subtype\s*\/FileAttachment(?:\s|[/>])/.test(serializedObjects)
  );
}

async function isValidRasterImage(
  format: "jpeg" | "png" | "gif" | "webp",
  bytes: Buffer,
): Promise<boolean> {
  const signatures: Record<typeof format, boolean> = {
    jpeg:
      bytes.length >= 3 &&
      bytes[0] === 0xff &&
      bytes[1] === 0xd8 &&
      bytes[2] === 0xff,
    png: bytes
      .subarray(0, 8)
      .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])),
    gif:
      bytes.subarray(0, 6).equals(Buffer.from("GIF87a")) ||
      bytes.subarray(0, 6).equals(Buffer.from("GIF89a")),
    webp:
      bytes.length >= 12 &&
      bytes.subarray(0, 4).equals(Buffer.from("RIFF")) &&
      bytes.subarray(8, 12).equals(Buffer.from("WEBP")),
  };
  if (!signatures[format]) return false;

  const { loadImage } = await import("@napi-rs/canvas");
  const image = await loadImage(bytes);
  return (
    Number.isFinite(image.width) &&
    image.width > 0 &&
    Number.isFinite(image.height) &&
    image.height > 0
  );
}

function isValidHeif(bytes: Buffer): boolean {
  if (bytes.length < 16) return false;
  let offset = 0;
  let sawFileType = false;
  let sawHeifBrand = false;
  while (offset + 8 <= bytes.length) {
    const size = bytes.readUInt32BE(offset);
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    let boxSize = size;
    let headerSize = 8;
    if (size === 1) {
      if (offset + 16 > bytes.length) return false;
      const extendedSize = bytes.readBigUInt64BE(offset + 8);
      if (extendedSize > BigInt(Number.MAX_SAFE_INTEGER)) return false;
      boxSize = Number(extendedSize);
      headerSize = 16;
    } else if (size === 0) {
      boxSize = bytes.length - offset;
    }
    if (boxSize < headerSize || offset + boxSize > bytes.length) return false;

    if (type === "ftyp") {
      if (sawFileType || boxSize < 16 || (boxSize - 16) % 4 !== 0) return false;
      sawFileType = true;
      const brands = [bytes.toString("ascii", offset + 8, offset + 12)];
      for (
        let brandOffset = offset + 16;
        brandOffset < offset + boxSize;
        brandOffset += 4
      ) {
        brands.push(bytes.toString("ascii", brandOffset, brandOffset + 4));
      }
      sawHeifBrand = brands.some((brand) =>
        ["heic", "heix", "hevc", "hevx", "mif1", "msf1"].includes(brand),
      );
    }
    offset += boxSize;
  }
  return offset === bytes.length && sawFileType && sawHeifBrand;
}

function isValidTiff(bytes: Buffer): boolean {
  if (bytes.length < 8) return false;
  const littleEndian = bytes.subarray(0, 2).toString("ascii") === "II";
  const bigEndian = bytes.subarray(0, 2).toString("ascii") === "MM";
  if (!littleEndian && !bigEndian) return false;
  const read16 = (offset: number) =>
    littleEndian ? bytes.readUInt16LE(offset) : bytes.readUInt16BE(offset);
  const read32 = (offset: number) =>
    littleEndian ? bytes.readUInt32LE(offset) : bytes.readUInt32BE(offset);
  if (read16(2) === 43) return isValidBigTiff(bytes, littleEndian);
  if (read16(2) !== 42) return false;
  const ifdOffset = read32(4);
  if (ifdOffset < 8 || ifdOffset + 2 > bytes.length) return false;
  const count = read16(ifdOffset);
  const ifdEnd = ifdOffset + 2 + count * 12;
  if (ifdEnd + 4 > bytes.length) return false;

  const typeSizes = [0, 1, 1, 2, 4, 8, 1, 1, 2, 4, 8, 4, 8];
  let width = false;
  let height = false;
  for (let index = 0; index < count; index += 1) {
    const entry = ifdOffset + 2 + index * 12;
    const tag = read16(entry);
    const type = read16(entry + 2);
    const valueCount = read32(entry + 4);
    const unitSize = typeSizes[type];
    if (
      !unitSize ||
      valueCount > Math.floor(Number.MAX_SAFE_INTEGER / unitSize)
    ) {
      return false;
    }
    const valueBytes = valueCount * unitSize;
    if (valueBytes > 4) {
      const valueOffset = read32(entry + 8);
      if (valueOffset < 8 || valueOffset + valueBytes > bytes.length) {
        return false;
      }
    }
    if (tag === 256 || tag === 257) {
      if (valueCount < 1 || (type !== 3 && type !== 4)) return false;
      const value =
        valueBytes <= 4
          ? type === 3
            ? read16(entry + 8)
            : read32(entry + 8)
          : 1;
      if (value < 1) return false;
      if (tag === 256) width = true;
      else height = true;
    }
  }
  return width && height;
}

function isValidBigTiff(bytes: Buffer, littleEndian: boolean): boolean {
  if (bytes.length < 16) return false;
  const read16 = (offset: number) =>
    littleEndian ? bytes.readUInt16LE(offset) : bytes.readUInt16BE(offset);
  const read64 = (offset: number) =>
    littleEndian ? bytes.readBigUInt64LE(offset) : bytes.readBigUInt64BE(offset);
  if (read16(4) !== 8 || read16(6) !== 0) return false;
  const firstIfd = read64(8);
  if (firstIfd > BigInt(Number.MAX_SAFE_INTEGER)) return false;
  const ifdOffset = Number(firstIfd);
  if (ifdOffset < 16 || ifdOffset + 8 > bytes.length) return false;
  const entryCount = read64(ifdOffset);
  if (
    entryCount >
    BigInt(Math.floor((bytes.length - ifdOffset - 16) / 20))
  ) {
    return false;
  }

  let width = false;
  let height = false;
  const typeSizes = [
    0, 1, 1, 2, 4, 8, 1, 1, 2, 4, 8, 4, 8, 0, 0, 0, 8, 8, 8,
  ];
  for (let index = 0n; index < entryCount; index += 1n) {
    const entry = ifdOffset + 8 + Number(index) * 20;
    const tag = read16(entry);
    const type = read16(entry + 2);
    const count = read64(entry + 4);
    const unitSize = typeSizes[type];
    if (!unitSize) return false;
    const valueBytes = count * BigInt(unitSize);
    if (valueBytes > BigInt(Number.MAX_SAFE_INTEGER)) return false;
    const valueLength = Number(valueBytes);
    if (valueLength > 8) {
      const valueOffset = read64(entry + 12);
      if (
        valueOffset > BigInt(Number.MAX_SAFE_INTEGER) ||
        Number(valueOffset) < 16 ||
        Number(valueOffset) + valueLength > bytes.length
      ) {
        return false;
      }
    }
    if (tag !== 256 && tag !== 257) continue;
    if (count < 1n || (type !== 3 && type !== 4 && type !== 16)) {
      return false;
    }
    const value =
      valueLength <= 8
        ? type === 3
          ? littleEndian
            ? bytes.readUInt16LE(entry + 12)
            : bytes.readUInt16BE(entry + 12)
          : type === 4
            ? littleEndian
              ? bytes.readUInt32LE(entry + 12)
              : bytes.readUInt32BE(entry + 12)
            : Number(
                littleEndian
                  ? bytes.readBigUInt64LE(entry + 12)
                  : bytes.readBigUInt64BE(entry + 12),
              )
        : 1;
    if (!Number.isSafeInteger(value) || value < 1) return false;
    if (tag === 256) width = true;
    else height = true;
  }
  return width && height;
}

function isValidCompoundFile(bytes: Buffer): boolean {
  const signature = Buffer.from([
    0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1,
  ]);
  if (bytes.length < 512 || !bytes.subarray(0, 8).equals(signature)) return false;
  const minorVersion = bytes.readUInt16LE(24);
  const majorVersion = bytes.readUInt16LE(26);
  const byteOrder = bytes.readUInt16LE(28);
  const sectorShift = bytes.readUInt16LE(30);
  const miniSectorShift = bytes.readUInt16LE(32);
  if (
    minorVersion !== 0x003e ||
    (majorVersion !== 3 && majorVersion !== 4) ||
    byteOrder !== 0xfffe ||
    sectorShift !== (majorVersion === 3 ? 9 : 12) ||
    miniSectorShift !== 6
  ) {
    return false;
  }
  const sectorSize = 1 << sectorShift;
  if (bytes.length < sectorSize || (bytes.length - 512) % sectorSize !== 0) {
    return false;
  }
  const numberOfFatSectors = bytes.readUInt32LE(44);
  const numberOfDirectorySectors = bytes.readUInt32LE(40);
  const numberOfSectors = (bytes.length - 512) / sectorSize;
  return (
    numberOfFatSectors > 0 &&
    numberOfFatSectors <= numberOfSectors &&
    numberOfDirectorySectors <= numberOfSectors
  );
}

function isValidDwg(bytes: Buffer): boolean {
  return (
    bytes.length >= 6 &&
    bytes.subarray(0, 4).toString("ascii") === "AC10" &&
    /^[0-9A-Z]{2}$/.test(bytes.subarray(4, 6).toString("ascii"))
  );
}

function isValidDxf(bytes: Buffer): boolean {
  const binaryHeader = Buffer.from("AutoCAD Binary DXF\r\n\x1a\0", "binary");
  if (bytes.subarray(0, binaryHeader.length).equals(binaryHeader)) {
    return bytes.length > binaryHeader.length;
  }
  if (bytes.length < 20 || bytes.includes(0)) return false;
  const text = bytes.toString("utf8");
  if (text.includes("\ufffd")) return false;
  const normalized = text.replace(/\r\n?/g, "\n").trim();
  return (
    /(?:^|\n)0\nSECTION\n/i.test(normalized) &&
    /(?:^|\n)0\nEOF(?:\n|$)/i.test(normalized)
  );
}

function isValidOfficeZip(
  bytes: Buffer,
  requiredEntry: string,
  root: string,
): boolean {
  const entries = parseZipEntries(bytes);
  if (!entries) return false;
  const contentTypes = entries.get("[Content_Types].xml");
  const required = entries.get(requiredEntry);
  if (!contentTypes || !required) return false;
  const contentTypeText = contentTypes.toString("utf8");
  const requiredText = required.toString("utf8");
  if (contentTypeText.includes("\ufffd") || requiredText.includes("\ufffd")) {
    return false;
  }
  const rootName = root === "word" ? "document" : "workbook";
  return (
    /<types(?:\s|>)/i.test(contentTypeText) &&
    /<\/types>/i.test(contentTypeText) &&
    new RegExp(`<[^>]*${rootName}(?:\\s|>)`, "i").test(requiredText) &&
    new RegExp(`</[^>]*${rootName}>`, "i").test(requiredText)
  );
}

function parseZipEntries(bytes: Buffer): Map<string, Buffer> | null {
  const minimumEnd = Math.max(0, bytes.length - 22 - 0xffff);
  let endOffset = -1;
  for (let offset = bytes.length - 22; offset >= minimumEnd; offset -= 1) {
    if (bytes.readUInt32LE(offset) === 0x06054b50) {
      endOffset = offset;
      break;
    }
  }
  if (endOffset < 0 || endOffset + 22 > bytes.length) return null;
  const disk = bytes.readUInt16LE(endOffset + 4);
  const centralDisk = bytes.readUInt16LE(endOffset + 6);
  const entriesOnDisk = bytes.readUInt16LE(endOffset + 8);
  const entryCount = bytes.readUInt16LE(endOffset + 10);
  const centralSize = bytes.readUInt32LE(endOffset + 12);
  const centralOffset = bytes.readUInt32LE(endOffset + 16);
  const commentLength = bytes.readUInt16LE(endOffset + 20);
  if (
    disk !== 0 ||
    centralDisk !== 0 ||
    entriesOnDisk !== entryCount ||
    commentLength !== bytes.length - endOffset - 22 ||
    entryCount === 0 ||
    entryCount === 0xffff ||
    centralSize === 0xffffffff ||
    centralOffset === 0xffffffff ||
    centralOffset + centralSize > endOffset
  ) {
    return null;
  }

  const entries = new Map<string, Buffer>();
  const ranges: Array<[number, number]> = [];
  let offset = centralOffset;
  let totalUncompressed = 0;
  for (let index = 0; index < entryCount; index += 1) {
    if (
      offset + 46 > endOffset ||
      bytes.readUInt32LE(offset) !== 0x02014b50
    ) {
      return null;
    }
    const flags = bytes.readUInt16LE(offset + 8);
    const method = bytes.readUInt16LE(offset + 10);
    const crc = bytes.readUInt32LE(offset + 16);
    const compressedSize = bytes.readUInt32LE(offset + 20);
    const uncompressedSize = bytes.readUInt32LE(offset + 24);
    const nameLength = bytes.readUInt16LE(offset + 28);
    const extraLength = bytes.readUInt16LE(offset + 30);
    const entryCommentLength = bytes.readUInt16LE(offset + 32);
    const localOffset = bytes.readUInt32LE(offset + 42);
    const recordLength = 46 + nameLength + extraLength + entryCommentLength;
    if (offset + recordLength > endOffset || (flags & 0x1) !== 0) return null;
    const name = bytes.toString(
      "utf8",
      offset + 46,
      offset + 46 + nameLength,
    );
    if (
      !name ||
      name.includes("\ufffd") ||
      name.startsWith("/") ||
      name.split("/").some((part) => part === "..") ||
      entries.has(name)
    ) {
      return null;
    }
    if (
      uncompressedSize > ZIP_MAX_ENTRY_BYTES ||
      totalUncompressed > ZIP_MAX_UNCOMPRESSED_BYTES - uncompressedSize
    ) {
      return null;
    }
    totalUncompressed += uncompressedSize;

    if (
      localOffset + 30 > centralOffset ||
      bytes.readUInt32LE(localOffset) !== 0x04034b50
    ) {
      return null;
    }
    const localNameLength = bytes.readUInt16LE(localOffset + 26);
    const localExtraLength = bytes.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const dataEnd = dataStart + compressedSize;
    if (
      dataStart > centralOffset ||
      dataEnd > centralOffset ||
      dataEnd < dataStart ||
      bytes.toString(
        "utf8",
        localOffset + 30,
        localOffset + 30 + localNameLength,
      ) !== name
    ) {
      return null;
    }
    for (const [rangeStart, rangeEnd] of ranges) {
      if (localOffset < rangeEnd && dataEnd > rangeStart) return null;
    }
    ranges.push([localOffset, dataEnd]);

    let data: Buffer;
    const compressed = bytes.subarray(dataStart, dataEnd);
    try {
      if (method === 0) {
        if (compressed.length !== uncompressedSize) return null;
        data = Buffer.from(compressed);
      } else if (method === 8) {
        data = inflateRawSync(compressed, { maxOutputLength: uncompressedSize });
        if (data.length !== uncompressedSize) return null;
      } else {
        return null;
      }
    } catch {
      return null;
    }
    if (crc32(data) !== crc) return null;
    entries.set(name, data);
    offset += recordLength;
  }
  return offset === centralOffset + centralSize ? entries : null;
}

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}