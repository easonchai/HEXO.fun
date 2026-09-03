/**
 * Playwright pass over the real HexVault UI on localnet:
 *   connect (dev burner) → deposit → pick tiles → DEPLOY → wait for the
 *   operator settle → laser/banner/takeover → claim round reward (if won) →
 *   withdraw.
 * Expects the stack from scripts/e2e-web.sh (validator, program, API) and the
 * test-asset mint printed by scripts/e2e-fixtures.ts.
 */
import { execSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { chromium } from "playwright";

const WEB_URL = process.env.HEXVAULT_WEB_URL ?? "http://localhost:5199";
const RPC = process.env.RPC_URL ?? "http://127.0.0.1:8899";
const USDC = process.env.HEXVAULT_E2E_USDC ?? "";

const sh = (cmd) =>
  execSync(cmd, { encoding: "utf8", shell: "/bin/zsh" }).trim();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(fn, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const value = await fn();
      if (value) return value;
    } catch {
      // retry
    }
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${label}`);
    await sleep(1000);
  }
}

async function main() {
  mkdirSync("screenshots", { recursive: true });

  // Deterministic burner keypair: same address the browser will connect.
  const burner = sh(`pnpm --dir apps/web exec tsx -e \
    'import {burnerKeypair} from "./src/dev-burner.ts"; console.log(burnerKeypair().publicKey.toBase58())'`);
  console.log(`burner wallet: ${burner}`);
  if (!USDC) throw new Error("HEXVAULT_E2E_USDC (test mint) not set");
  sh(`pnpm exec tsx scripts/fund-wallet.ts ${burner} ${USDC}`);
  console.log("burner funded (5 SOL + 500 USDC)");

  const browser = await chromium.launch();
  const page = await browser.newPage({
    viewport: { width: 1600, height: 950 },
  });
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  await page.goto(WEB_URL);
  await page.waitForSelector('[data-testid="arena"]');

  // 1. Connect the burner wallet through the app's CONNECT button.
  await page.click('[data-testid="connect-button"]');
  await page.waitForSelector(".wallet-adapter-modal-list", { timeout: 20000 });
  await page
    .locator('.wallet-adapter-modal-list li:has-text("Localnet Burner") button')
    .first()
    .click();
  await sleep(1500);
  await page.keyboard.press("Escape").catch(() => {});
  await waitFor(
    () =>
      page
        .locator('[data-testid="wallet-address"]')
        .filter({ hasText: burner.slice(0, 4) })
        .isVisible(),
    20000,
    "burner wallet connected",
  );
  console.log("ok: burner connected");

  // 2. Deposit from the panel's vault row (mints PT + ET 1:1).
  await waitFor(
    () => page.locator('[data-testid="quick-deposit-10"]').isEnabled(),
    30000,
    "deposit control enabled (pool discovered)",
  );
  await page.click('[data-testid="quick-deposit-10"]');
  await waitFor(
    () =>
      page
        .locator('[data-testid="wallet-address"]')
        .filter({ hasText: /ET 10/ })
        .isVisible(),
    60000,
    "ET balance after deposit",
  );
  console.log("ok: deposited 10 USDC → PT + ET");

  // 3. Wait for an open round (operator bot opens rounds).
  await waitFor(
    () =>
      page
        .locator('[data-testid="round-timer"]')
        .filter({ hasNotText: "00:00" })
        .isVisible(),
    90000,
    "an open round with a ticking timer",
  );
  console.log("ok: round open, timer running");

  // 3. Cover every tile with the ALL preset so the round win is guaranteed
  //    and the reward-claim path is exercised deterministically.
  await page.click('.preset:has-text("ALL")');
  const count = (
    await page.locator('[data-testid="tile-count"]').textContent()
  )?.trim();
  if (count !== "36")
    throw new Error(`expected 36 selected tiles, got ${count}`);
  console.log("ok: all 36 tiles selected (guaranteed round win)");

  // 4. Stake 0.01 ET/tile (pool max is 0.1) → 0.36 ET total.
  await page.fill('[data-testid="stake-input"]', "0.01");
  await waitFor(
    () => page.locator('[data-testid="deploy"]:not([disabled])').isVisible(),
    15000,
    "DEPLOY enabled",
  );
  await page.click('[data-testid="deploy"]');
  await waitFor(
    () =>
      page
        .locator('[data-testid="deployed-total"]')
        .filter({ hasText: "0.36" })
        .isVisible(),
    60000,
    "deployed position reflected (0.36 ET)",
  );
  console.log("ok: position deployed");

  // 5. Wait for the settle reveal (operator draws after the round closes).
  await waitFor(
    () =>
      page.locator('[data-testid="win-banner"]').isVisible() ||
      page.locator('[data-testid="takeover"]').isVisible() ||
      page.locator('[data-testid="awaiting-note"]').isVisible(),
    420000,
    "round settle reveal (banner / takeover / awaiting)",
  );
  const banner = await page
    .locator('[data-testid="win-banner"]')
    .textContent()
    .catch(() => null);
  console.log(`ok: settle reached (banner: ${banner ?? "none"})`);
  await page.screenshot({ path: "screenshots/e2e-web-settle.png" });

  // 6. The burner covered every tile: dismiss the YOU WON takeover (it
  //    blocks the panel), then claim the round reward from the UI.
  await waitFor(
    () =>
      page
        .locator('[data-testid="takeover"][data-title="YOU WON"]')
        .isVisible(),
    30000,
    "YOU WON takeover",
  );
  console.log("ok: YOU WON takeover shown");
  await page.click('[data-testid="takeover"]');
  await page.click('[data-testid="claim-round-reward"]');
  await waitFor(
    () =>
      page
        .locator('[data-testid="deploy-note"]')
        .filter({ hasText: "reward claimed" })
        .isVisible(),
    90000,
    "round reward claimed",
  );
  console.log("ok: round reward claimed from the UI");

  // 7. Withdraw dust through the VAULT tab.
  await page.click('[data-testid="tab-vault"]');
  await page.fill('[data-testid="withdraw-input"]', "0.000001");
  await page.click('[data-testid="withdraw-submit"]');
  await waitFor(
    () =>
      page
        .locator('[data-testid="vault-note"]')
        .filter({ hasText: "Withdraw confirmed" })
        .isVisible(),
    60000,
    "withdraw confirmed",
  );
  console.log("ok: withdraw confirmed from the UI");

  const errors = pageErrors.filter((text) => !/ResizeObserver/.test(text));
  if (errors.length > 0) {
    throw new Error(`page errors during pass: ${errors.join(" | ")}`);
  }
  await page.screenshot({ path: "screenshots/e2e-web-final.png" });
  await browser.close();
  console.log("E2E-WEB BROWSER PASS COMPLETE");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
