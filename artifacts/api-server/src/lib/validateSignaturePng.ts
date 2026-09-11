import { inflateSync } from "node:zlib";

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const MAX_DIMENSION = 2_000;
const MIN_INK_PIXELS = 10;

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/**
 * Validates the browser canvas PNG and confirms it contains visible dark ink.
 * Supports the non-interlaced 8-bit RGB/RGBA PNGs produced by canvas.toDataURL.
 */
export function hasMeaningfulSignatureInk(dataUrl: string): boolean {
  const prefix = "data:image/png;base64,";
  if (!dataUrl.startsWith(prefix)) return false;

  try {
    const png = Buffer.from(dataUrl.slice(prefix.length), "base64");
    if (png.length < 50 || !png.subarray(0, 8).equals(PNG_SIGNATURE)) return false;

    let offset = 8;
    let width = 0;
    let height = 0;
    let bytesPerPixel = 0;
    let sawHeader = false;
    let sawEnd = false;
    const compressed: Buffer[] = [];

    while (offset + 12 <= png.length) {
      const length = png.readUInt32BE(offset);
      if (length > png.length - offset - 12) return false;
      const type = png.toString("ascii", offset + 4, offset + 8);
      const data = png.subarray(offset + 8, offset + 8 + length);
      offset += 12 + length;

      if (type === "IHDR") {
        if (sawHeader || length !== 13) return false;
        sawHeader = true;
        width = data.readUInt32BE(0);
        height = data.readUInt32BE(4);
        const bitDepth = data[8];
        const colorType = data[9];
        const compression = data[10];
        const filter = data[11];
        const interlace = data[12];
        if (
          width < 1 ||
          height < 1 ||
          width > MAX_DIMENSION ||
          height > MAX_DIMENSION ||
          bitDepth !== 8 ||
          (colorType !== 2 && colorType !== 6) ||
          compression !== 0 ||
          filter !== 0 ||
          interlace !== 0
        ) {
          return false;
        }
        bytesPerPixel = colorType === 6 ? 4 : 3;
      } else if (type === "IDAT") {
        if (!sawHeader) return false;
        compressed.push(data);
      } else if (type === "IEND") {
        sawEnd = true;
        break;
      }
    }

    if (!sawHeader || !sawEnd || compressed.length === 0) return false;
    const scanlineBytes = width * bytesPerPixel;
    const expectedBytes = height * (scanlineBytes + 1);
    const raw = inflateSync(Buffer.concat(compressed), {
      maxOutputLength: expectedBytes,
    });
    if (raw.length !== expectedBytes) return false;

    let previous = Buffer.alloc(scanlineBytes);
    let rawOffset = 0;
    let inkPixels = 0;

    for (let y = 0; y < height; y++) {
      const filterType = raw[rawOffset++];
      if (filterType > 4) return false;
      const row = Buffer.allocUnsafe(scanlineBytes);
      for (let x = 0; x < scanlineBytes; x++) {
        const encoded = raw[rawOffset++];
        const left = x >= bytesPerPixel ? row[x - bytesPerPixel] : 0;
        const above = previous[x];
        const upperLeft = x >= bytesPerPixel ? previous[x - bytesPerPixel] : 0;
        const predictor =
          filterType === 0
            ? 0
            : filterType === 1
              ? left
              : filterType === 2
                ? above
                : filterType === 3
                  ? Math.floor((left + above) / 2)
                  : paeth(left, above, upperLeft);
        row[x] = (encoded + predictor) & 0xff;
      }

      for (let x = 0; x < width; x++) {
        const pixel = x * bytesPerPixel;
        const alpha = bytesPerPixel === 4 ? row[pixel + 3] : 255;
        const darkness = 255 - (row[pixel] + row[pixel + 1] + row[pixel + 2]) / 3;
        if (alpha >= 32 && darkness >= 40) {
          inkPixels++;
          if (inkPixels >= MIN_INK_PIXELS) return true;
        }
      }
      previous = row;
    }
    return false;
  } catch {
    return false;
  }
}