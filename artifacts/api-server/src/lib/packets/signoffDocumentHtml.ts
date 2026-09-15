import { readFile } from "node:fs/promises";
import { accessSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { chromium, type Browser, type BrowserContext } from "playwright-core";
import {
  SignoffDocumentPrint,
  type SignoffDocumentProps,
} from "@workspace/signoff-document";

const RENDER_TIMEOUT_MS = 60_000;
const MAX_RENDERERS = 2;
const MAX_GLOBAL_RENDERER_SLOTS = 4;
const DEFAULT_GLOBAL_RENDERER_SLOTS = 2;
const GLOBAL_RENDERER_LOCK_BASE = 7_472_657_500;
const GLOBAL_RENDERER_POLL_MS = 100;
let activeRenderers = 0;
const rendererWaiters: Array<() => void> = [];

async function withTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function closeWithDeadline(close: () => Promise<void>): Promise<void> {
  await withTimeout(
    close(),
    1_000,
    "Signoff PDF renderer cleanup exceeded its time limit.",
  ).catch(() => undefined);
}

function globalRendererSlotCount(): number {
  const configured = Number(process.env.SIGNOFF_RENDERER_GLOBAL_SLOTS);
  return Number.isSafeInteger(configured) &&
    configured >= 1 &&
    configured <= MAX_GLOBAL_RENDERER_SLOTS
    ? configured
    : DEFAULT_GLOBAL_RENDERER_SLOTS;
}

async function acquireGlobalRendererSlot(
  deadline: number,
): Promise<() => Promise<void>> {
  // Unit tests intentionally exercise the renderer without starting a
  // database. Production requests always use the advisory-lock path below.
  if (process.env.NODE_ENV === "test") return async () => undefined;
  const remaining = () => {
    const value = deadline - Date.now();
    if (value <= 0) {
      throw new Error(
        "Signoff PDF renderer capacity wait exceeded its time limit.",
      );
    }
    return value;
  };
  const { pool } = await withTimeout(
    import("@workspace/db"),
    remaining(),
    "Signoff PDF renderer setup exceeded its time limit.",
  );
  const clientPromise = pool.connect();
  let client: Awaited<typeof clientPromise>;
  try {
    client = await withTimeout(
      clientPromise,
      remaining(),
      "Signoff PDF renderer capacity setup exceeded its time limit.",
    );
  } catch (error) {
    void clientPromise
      .then((lateClient) =>
        lateClient.release(error instanceof Error ? error : undefined),
      )
      .catch(() => undefined);
    throw error;
  }
  let clientReleased = false;
  const releaseClient = (error?: Error) => {
    if (clientReleased) return;
    clientReleased = true;
    client.release(error);
  };
  try {
    while (Date.now() < deadline) {
      for (let slot = 0; slot < globalRendererSlotCount(); slot += 1) {
        const key = GLOBAL_RENDERER_LOCK_BASE + slot;
        const queryTimeout = remaining();
        const result = await withTimeout(
          client.query<{ acquired: boolean }>(
            "SELECT pg_try_advisory_lock($1::bigint) AS acquired",
            [key],
          ),
          queryTimeout,
          "Signoff PDF renderer capacity query exceeded its time limit.",
        );
        if (!result.rows[0]?.acquired) continue;
        let released = false;
        return async () => {
          if (released) return;
          released = true;
          try {
            await client.query("SELECT pg_advisory_unlock($1::bigint)", [key]);
            releaseClient();
          } catch (error) {
            releaseClient(
              error instanceof Error ? error : new Error(String(error)),
            );
            throw error;
          }
        };
      }
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(GLOBAL_RENDERER_POLL_MS, remaining())),
      );
    }
    releaseClient();
    throw new Error(
      "Signoff PDF renderer capacity wait exceeded its time limit.",
    );
  } catch (error) {
    releaseClient(error instanceof Error ? error : new Error(String(error)));
    throw error;
  }
}

async function acquireRenderer(deadline: number): Promise<() => void> {
  while (activeRenderers >= MAX_RENDERERS) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new Error(
        "Signoff PDF renderer capacity wait exceeded its time limit.",
      );
    }
    await new Promise<void>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout>;
      let settled = false;
      const waiter = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        const index = rendererWaiters.indexOf(waiter);
        if (index >= 0) rendererWaiters.splice(index, 1);
        reject(
          new Error(
            "Signoff PDF renderer capacity wait exceeded its time limit.",
          ),
        );
      }, remaining);
      rendererWaiters.push(waiter);
    });
  }
  activeRenderers += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    activeRenderers -= 1;
    rendererWaiters.shift()?.();
  };
}

async function readAsset(name: string): Promise<Buffer> {
  const candidates = [
    new URL(`./assets/${name}`, import.meta.url),
    new URL(`../../../assets/${name}`, import.meta.url),
    new URL(`../../../../quote-tracker/public/${name}`, import.meta.url),
    new URL(
      `../../../../artifacts/quote-tracker/public/${name}`,
      import.meta.url,
    ),
  ];
  let lastError: unknown;
  for (const candidate of candidates) {
    try {
      return await readFile(candidate);
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(
    `Required signoff PDF asset ${name} is unavailable: ${
      lastError instanceof Error ? lastError.message : "unknown error"
    }`,
  );
}

function chromiumExecutablePath(): string {
  const configured = process.env.CHROMIUM_PATH?.trim();
  if (configured) return configured;
  const result = spawnSync("which", ["chromium"], { encoding: "utf8" });
  const executable = result.status === 0 ? result.stdout.trim() : "";
  if (executable) return executable;
  for (const candidate of ["/usr/bin/chromium", "/usr/bin/chromium-browser"]) {
    try {
      accessSync(candidate);
      return candidate;
    } catch {
      // Continue to the actionable error below.
    }
  }
  throw new Error(
    "Chromium is required for signoff PDF generation. Set CHROMIUM_PATH or provide chromium on PATH.",
  );
}

async function standaloneHtml(
  props: Omit<SignoffDocumentProps, "logoSrc">,
): Promise<string> {
  const [cssTemplate, regularFont, boldFont, logo] = await Promise.all([
    readAsset("signoff-document.css"),
    readAsset("fonts/DejaVuSans.ttf"),
    readAsset("fonts/DejaVuSans-Bold.ttf"),
    readAsset("logo.png"),
  ]);
  const dataFont = (font: Buffer) =>
    `data:font/ttf;base64,${font.toString("base64")}`;
  const css = cssTemplate
    .toString("utf8")
    .replaceAll("__REGULAR_FONT__", dataFont(regularFont))
    .replaceAll("__BOLD_FONT__", dataFont(boldFont));
  const logoSrc = `data:image/png;base64,${logo.toString("base64")}`;
  const document = createElement(SignoffDocumentPrint, { ...props, logoSrc });
  return `<!doctype html><html><head><meta charset="utf-8"><style>${css}</style></head><body><main class="max-w-4xl mx-auto p-4 sm:p-8 print:p-0">${renderToStaticMarkup(document)}</main></body></html>`;
}

export async function renderSignoffDocumentHtmlPdf(
  props: Omit<SignoffDocumentProps, "logoSrc">,
): Promise<Uint8Array> {
  const deadline = Date.now() + RENDER_TIMEOUT_MS;
  const releaseRenderer = await acquireRenderer(deadline);
  let releaseGlobalRenderer: (() => Promise<void>) | undefined;
  let browser: Browser | undefined;
  let context: BrowserContext | undefined;
  try {
    releaseGlobalRenderer = await acquireGlobalRendererSlot(deadline);
    const remaining = () => {
      const value = deadline - Date.now();
      if (value <= 0) {
        throw new Error("Signoff PDF rendering exceeded its time limit.");
      }
      return value;
    };
    const html = await withTimeout(
      standaloneHtml(props),
      remaining(),
      "Signoff PDF renderer setup exceeded its time limit.",
    );
    const browserPromise = chromium.launch({
      executablePath: chromiumExecutablePath(),
      headless: true,
      chromiumSandbox: true,
      timeout: remaining(),
      args: ["--disable-dev-shm-usage"],
    });
    try {
      browser = await withTimeout(
        browserPromise,
        remaining(),
        "Signoff PDF Chromium launch exceeded its time limit.",
      );
    } catch (error) {
      void browserPromise
        .then((lateBrowser) => closeWithDeadline(() => lateBrowser.close()))
        .catch(() => undefined);
      throw error;
    }
    context = await withTimeout(
      browser.newContext(),
      remaining(),
      "Signoff PDF browser context setup exceeded its time limit.",
    );
    await withTimeout(
      context.setOffline(true),
      remaining(),
      "Signoff PDF browser offline setup exceeded its time limit.",
    );
    const page = await withTimeout(
      context.newPage(),
      remaining(),
      "Signoff PDF page setup exceeded its time limit.",
    );
    page.setDefaultTimeout(remaining());
    // setContent never needs navigation. Aborting every request is a second
    // guard against a future presentation change accidentally introducing a
    // mutable quote/token or external asset dependency.
    await withTimeout(
      page.route("**/*", (route) => route.abort()),
      remaining(),
      "Signoff PDF request routing setup exceeded its time limit.",
    );
    await page.setContent(html, {
      waitUntil: "load",
      timeout: remaining(),
    });
    await withTimeout(
      page.evaluate("document.fonts.ready"),
      remaining(),
      "Signoff PDF font loading exceeded its time limit.",
    );
    const pdf = await withTimeout(
      page.pdf({
        format: "Letter",
        printBackground: true,
        preferCSSPageSize: true,
      }),
      remaining(),
      "Signoff PDF rendering exceeded its time limit.",
    );
    return pdf;
  } finally {
    if (context) {
      await closeWithDeadline(() => context!.close());
    }
    if (browser) {
      await closeWithDeadline(() => browser!.close());
    }
    if (releaseGlobalRenderer) {
      await releaseGlobalRenderer().catch(() => undefined);
    }
    releaseRenderer();
  }
}
