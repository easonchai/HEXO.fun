/**
 * Wallet menu on phones: the topbar hides the Tickets and balance chips at
 * 390px, so the dropdown under the address pill is the only place a phone
 * user sees them. Needs a connected wallet, so unlike the other phone specs
 * this drives the dev burner wallet and needs the same local stack as
 * demo.spec.ts (see that file's header). Runs only on the "phone" project.
 */
import { expect, test, type Page } from "playwright/test";

async function connectBurnerWallet(page: Page): Promise<void> {
  await page.goto("/");
  await page.getByTestId("connect-button").click();
  const burnerOption = page.getByRole("button", { name: /burner/i });
  if (await burnerOption.isVisible({ timeout: 5_000 }).catch(() => false)) {
    await burnerOption.click();
  }
  await expect(page.getByTestId("connect-button")).toHaveAttribute(
    "title",
    /^Copy /,
    { timeout: 15_000 },
  );
}

async function assertFullyInViewport(page: Page, testId: string): Promise<void> {
  const box = await page.getByTestId(testId).boundingBox();
  expect(box, `${testId} has no box (not rendered)`).not.toBeNull();
  const viewport = page.viewportSize();
  expect(viewport).not.toBeNull();
  if (!box || !viewport) return;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(viewport.width + 1);
  expect(box.y + box.height).toBeLessThanOrEqual(viewport.height + 1);
}

test.describe("phone wallet menu", () => {
  test("shows balances, copies the address, and disconnects", async ({
    page,
  }) => {
    await connectBurnerWallet(page);

    // Chips are hidden on phones; the menu is where the balances live.
    await expect(page.getByTestId("topbar-balance")).not.toBeVisible();
    await page.getByTestId("connect-button").click();
    await expect(page.getByTestId("wallet-menu")).toBeVisible();
    await expect(page.getByTestId("wallet-menu-tickets")).toContainText("Tickets");
    await expect(page.getByTestId("wallet-menu-balance")).toBeVisible();
    await assertFullyInViewport(page, "wallet-menu");

    // Copy keeps the menu open and flips the label.
    await page.getByTestId("copy-address-button").click();
    await expect(page.getByTestId("copy-address-button")).toContainText("Copied");
    await expect(page.getByTestId("wallet-menu")).toBeVisible();

    // Outside tap closes it; reopen and disconnect.
    await page.mouse.click(10, 300);
    await expect(page.getByTestId("wallet-menu")).toHaveCount(0);
    await page.getByTestId("connect-button").click();
    await page.getByTestId("disconnect-button").click();
    await expect(page.getByTestId("wallet-menu")).toHaveCount(0);
    await expect(page.getByTestId("connect-button")).toHaveText("CONNECT", {
      timeout: 10_000,
    });
  });
});
