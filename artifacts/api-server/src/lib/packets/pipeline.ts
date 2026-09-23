import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile, lstat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MiB = 1024 * 1024;
/** RSS includes the renderer thread. Reserve native raster/encoder workspace,
 * next output, upload Buffer.from copies, and 128 MiB of unrelated API work. */
export function admitPageOverlap(input: {
  currentPixels: number; nextPixels: number; retainedBytes: number; rss: number;
}): boolean {
  const { currentPixels, nextPixels, retainedBytes, rss } = input;
  return Object.values(input).every((n) => Number.isSafeInteger(n) && n > 0) &&
    currentPixels + nextPixels <= 12_000_000 &&
    retainedBytes * 2 <= 32 * MiB &&
    rss + retainedBytes * 2 + nextPixels * 24 + 128 * MiB < 768 * MiB;
}

/** One render at a time; one speculative result at most. Persist the valid
 * current page even if the speculative render fails. Never return while work
 * can still write objects. Promise thunks also capture synchronous throws. */
export async function runPagePipeline<T>(options: {
  start: number; end: number;
  render: (index: number) => Promise<T>;
  persist: (value: T, index: number) => Promise<void>;
  admit: (value: T, index: number) => boolean;
}): Promise<void> {
  const render = (index: number) => Promise.resolve().then(() => options.render(index));
  let pending: Promise<T> | undefined;
  try {
    for (let index = options.start; index < options.end; index++) {
      let value: T | undefined = await (pending ?? render(index));
      pending = undefined;
      if (index + 1 < options.end && options.admit(value, index)) {
        pending = render(index + 1);
        // Install rejection handler immediately, without swallowing the awaited error.
        void pending.catch(() => {});
      }
      await options.persist(value, index);
      value = undefined;
    }
  } finally {
    if (pending) await Promise.allSettled([pending]);
  }
}

export async function settleUploads(writes: Array<() => Promise<unknown>>): Promise<void> {
  for (let i = 0; i < writes.length; i += 2) {
    const results = await Promise.allSettled(
      writes.slice(i, i + 2).map((write) => Promise.resolve().then(write)),
    );
    const failure = results.find((result) => result.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
  }
}

type Checkpoint = { pdfPath: string; pdfBytes: number; pdfSha256: string };
function verify(bytes: Uint8Array, checkpoint: Checkpoint): void {
  if (bytes.length !== checkpoint.pdfBytes ||
      createHash("sha256").update(bytes).digest("hex") !== checkpoint.pdfSha256) {
    throw new Error("Stored packet checkpoint failed integrity verification.");
  }
}

/** Private, attempt-local, bounded scratch only; remote immutable objects remain
 * authoritative for recovery. A corrupt local file is an error, never trusted. */
export class LocalCheckpointStage {
  private directory?: string;
  private paths = new Map<string, string>();
  private used = 0;
  private sequence = 0;
  constructor(private readonly maxBytes: number) {}
  async outputPath(): Promise<string> {
    this.directory ??= await mkdtemp(join(tmpdir(), "packet-checkpoints-"));
    return join(this.directory, "merged.pdf");
  }
  async put(checkpoint: Checkpoint, bytes: Uint8Array): Promise<void> {
    verify(bytes, checkpoint);
    if (this.paths.has(checkpoint.pdfPath)) return;
    if (this.used + bytes.length > this.maxBytes) throw new Error("Checkpoint staging exceeds disk budget.");
    this.directory ??= await mkdtemp(join(tmpdir(), "packet-checkpoints-"));
    const path = join(this.directory, `${this.sequence++}.pdf`);
    try {
      await writeFile(path, bytes, { flag: "wx", mode: 0o600 });
    } catch (error) {
      await rm(path, { force: true });
      throw error;
    }
    this.paths.set(checkpoint.pdfPath, path);
    this.used += bytes.length;
  }
  async resolve(checkpoint: Checkpoint, download: () => Promise<Uint8Array>): Promise<string> {
    const path = this.paths.get(checkpoint.pdfPath);
    if (path) {
      try {
        const info = await lstat(path);
        if (!info.isFile() || info.size !== checkpoint.pdfBytes) throw new Error("Local checkpoint failed integrity verification.");
        verify(await readFile(path), checkpoint);
        return path;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        this.paths.delete(checkpoint.pdfPath);
        this.used -= checkpoint.pdfBytes;
      }
    }
    const bytes = await download();
    await this.put(checkpoint, bytes);
    return this.paths.get(checkpoint.pdfPath)!;
  }
  async close(): Promise<void> {
    if (this.directory) await rm(this.directory, { recursive: true, force: true });
    this.paths.clear();
    this.used = 0;
    this.directory = undefined;
  }
}