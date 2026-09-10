/**
 * ABOUT tab on a phone: single column, no horizontal overflow, the navbar
 * entry is reachable. Runs only on the "phone" Playwright project.
 */
import { expect, test } from "playwright/test";

test("about page stacks without horizontal overflow", async ({ page }) => {
  await page.goto("/#about");
  await expect(page.getByTestId("about-screen")).toBeVisible();
  await expect(page.getByTestId("tab-about")).toBeVisible();

  const { scrollWidth, viewportWidth } = await page.evaluate(() => {
    const el = document.querySelector<HTMLElement>(".about")!;
    return { scrollWidth: el.scrollWidth, viewportWidth: window.innerWidth };
  });
  expect(scrollWidth).toBe(viewportWidth);

  // Board above the copy, both inside the viewport width.
  const board = await page.getByTestId("demo-board").boundingBox();
  const h1 = await page.getByRole("heading", { level: 1 }).boundingBox();
  expect(board).not.toBeNull();
  expect(h1).not.toBeNull();
  expect(board!.y).toBeLessThan(h1!.y);
  expect(board!.width).toBeLessThanOrEqual(viewportWidth);
});
