import { defineConfig, devices } from "@playwright/test";
import { execSync } from "node:child_process";

// On NixOS, Playwright's downloaded browsers don't run; use the system chromium.
function systemChromium(): string {
  try {
    return execSync("which chromium").toString().trim();
  } catch {
    throw new Error("chromium not found on PATH — install it as a system dependency");
  }
}

export default defineConfig({
  testDir: "./tests",
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 1,
  reporter: [["list"]],
  globalSetup: "./global-setup.ts",
  use: {
    // The Replit proxy serves the quote-tracker app at "/" and the API at "/api".
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:80",
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        launchOptions: { executablePath: systemChromium() },
      },
    },
  ],
});
