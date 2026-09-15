import assert from "node:assert/strict";
import test from "node:test";
import { PDFDocument, PDFName, PDFString } from "pdf-lib";
import {
  attachmentContentDisposition,
  attachmentFilenameMatchesContentType,
  validateAttachmentBytes,
} from "./attachmentValidation";

const ONE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL9NwAAAABJRU5ErkJggg==",
  "base64",
);

test("attachment byte validation rejects MIME spoofing and malformed images", async () => {
  assert.equal(
    attachmentFilenameMatchesContentType("drawing.png", "image/png"),
    true,
  );
  assert.equal(
    attachmentFilenameMatchesContentType("drawing.jpg", "image/png"),
    false,
  );
  assert.equal(
    await validateAttachmentBytes("drawing.png", "image/png", ONE_PIXEL_PNG),
    null,
  );
  assert.match(
    (await validateAttachmentBytes(
      "drawing.jpg",
      "image/jpeg",
      ONE_PIXEL_PNG,
    )) ?? "",
    /does not match its declared type/,
  );
  assert.match(
    (await validateAttachmentBytes(
      "drawing.jpg",
      "image/png",
      ONE_PIXEL_PNG,
    )) ?? "",
    /file name extension does not match/,
  );
  assert.match(
    (await validateAttachmentBytes(
      "drawing.png",
      "image/png",
      Buffer.from(ONE_PIXEL_PNG.subarray(0, 20)),
    )) ?? "",
    /malformed|does not match its declared type/,
  );
});

test("CAD header validation keeps DWG and DXF attachments supported", async () => {
  assert.equal(
    await validateAttachmentBytes(
      "plan.dwg",
      "application/octet-stream",
      Buffer.from("AC1027"),
    ),
    null,
  );
  assert.equal(
    await validateAttachmentBytes(
      "plan.dxf",
      "application/octet-stream",
      Buffer.from("0\nSECTION\n2\nHEADER\n0\nENDSEC\n0\nEOF\n"),
    ),
    null,
  );
});

test("PDF validation rejects JavaScript, embedded files, and launch actions", async () => {
  const createPdf = async () => {
    const document = await PDFDocument.create();
    document.addPage();
    return document;
  };
  const validatePdfDocument = async (document: PDFDocument) =>
    validateAttachmentBytes(
      "document.pdf",
      "application/pdf",
      Buffer.from(await document.save()),
    );

  assert.equal(await validatePdfDocument(await createPdf()), null);

  const withJavaScript = await createPdf();
  withJavaScript.addJavaScript("unsafe", "app.alert('unsafe')");
  assert.match(
    (await validatePdfDocument(withJavaScript)) ?? "",
    /malformed|declared|safely/,
  );

  const withEmbeddedFile = await createPdf();
  await withEmbeddedFile.attach(new Uint8Array([1, 2, 3]), "unsafe.bin");
  assert.match(
    (await validatePdfDocument(withEmbeddedFile)) ?? "",
    /malformed|declared|safely/,
  );

  const withLaunchAction = await createPdf();
  withLaunchAction.catalog.set(
    PDFName.of("OpenAction"),
    withLaunchAction.context.obj({
      S: PDFName.of("Launch"),
      F: PDFString.of("unsafe.exe"),
    }),
  );
  assert.match(
    (await validatePdfDocument(withLaunchAction)) ?? "",
    /malformed|declared|safely/,
  );
});

test("attachment download disposition cannot contain a path or control character", () => {
  const header = attachmentContentDisposition('..\\evil"\r\n.pdf');
  assert.match(header, /^attachment; filename="/);
  assert.equal(header.includes("\r"), false);
  assert.equal(header.includes("\n"), false);
  assert.equal(header.includes("..\\"), false);
});
