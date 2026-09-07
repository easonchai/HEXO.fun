import { defineConfig, devices } from "playwright/test";

/**
 * Ticket 12 (deploy) has not landed a live URL yet. See 13's ticket file.
 * Until it does, this defaults to a local Vite dev server. The moment a
 * Vercel URL exists, point E2E_BASE_URL at it and nothing here changes.
 */
const baseURL = process.env.E2E_BASE_URL ?? "http://127.0.0.1:5173";
const isLocal = /^https?:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/.test(baseURL);

export default defineConfig({
  testDir: "./e2e",
  // A round is 60s by default (spec.md §7) and the flow waits out one full
  // round plus settlement, so the per-test budget has to clear that.
  timeout: 180_000,
  fullyParallel: false,
  retries: 0,
  reporter: "list",
  use: {
    baseURL,
    trace: "retain-on-failure",
  },
  // ponytail: only auto-boot the dev server for the local default target.
  // Pointing E2E_BASE_URL at a deployed environment (Vercel, once ticket 12
  // lands) skips this. There is nothing to start, and nothing to
  // accidentally spin up against a URL that's already live.
  webServer: isLocal
    ? {
        command: "pnpm dev",
        url: baseURL,
        reuseExistingServer: !process.env.CI,
        timeout: 30_000,
      }
    : undefined,
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
      // Anything named *.phone.spec.ts is phone-only; keep it off desktop.
      testIgnore: "**/*.phone.spec.ts",
    },
    {
      // iPhone 13: 390px wide, WebKit. Run `pnpm exec playwright install
      // webkit` once locally before this project can launch a browser.
      name: "phone",
      use: { ...devices["iPhone 13"] },
      testMatch: "**/*.phone.spec.ts",
    },
  ],
});
