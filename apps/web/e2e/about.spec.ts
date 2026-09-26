/**
 * ABOUT tab smoke: the page mounts from its hash, the self-playing board
 * renders its 36 tiles, and the FAQ opens natively. The clicks below need
 * the invite gate down first (see e2e/gate.ts and demo.spec.ts's header for
 * the env vars), which means the burner wallet and a backend that admits
 * it: no longer a no-wallet, no-backend spec.
 */
import { expect, test } from "playwright/test";

import { passAccessGate } from "./gate.js";

test.use({ viewport: { width: 1280, height: 900 } });

test("about page renders", async ({ page }) => {
  await page.goto("/#about");
  await passAccessGate(page);
  await expect(page.getByTestId("about-screen")).toBeVisible();
  await expect(page.getByRole("heading", { level: 1 })).toContainText(
    "play your luck",
  );
  await expect(page.getByTestId("demo-board").locator("[data-tile]")).toHaveCount(36);

  const first = page.getByTestId("about-faq").locator("details").first();
  await expect(first).not.toHaveAttribute("open", "");
  await first.locator("summary").click();
  await expect(first).toHaveAttribute("open", "");
  await expect(first.locator("p")).toContainText("Only tickets are.");

  await page.getByTestId("tab-about").click();
  await expect(page.getByTestId("about-screen")).toBeVisible();
});
