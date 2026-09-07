/**
 * PRD §9 demo loop, end to end: faucet, deposit, play a round, settle, and
 * withdraw the matched amount. See docs/product-requirements.md §9.
 *
 * Base URL: E2E_BASE_URL, default http://127.0.0.1:5173 (see
 * playwright.config.ts). Ticket 12 has not deployed anything yet, so there is
 * no live URL to default to. Point E2E_BASE_URL at the Vercel URL the
 * moment it exists; nothing else in this file changes.
 *
 * Wallet: this drives the app's dev burner wallet (src/dev-burner.ts),
 * `VITE_BURNER_WALLET=1` against a local RPC. That path exists specifically
 * for "automated browser testing" per its own doc comment. It requires a
 * full local stack behind the page: a local validator with the program
 * deployed, the backend (indexer + operator + api) pointed at it, and the
 * frontend's own env pointed at both. `docs/plan/rebuild/progress.md`
 * "Running the localnet suite" covers the validator half.
 *
 * ponytail: the eventual live run (against Vercel, once ticket 12 lands)
 * won't have a local RPC, so the burner wallet's gate (src/dev-burner.ts
 * isLocalRpc) disables it there and the app falls back to Privy. This spec
 * does not drive a Privy login. That needs Privy's own test-mode
 * configuration (a guest/test login path), which is a human/product decision
 * this ticket wasn't scoped to make. Ceiling: this spec only runs
 * unattended against a local stack. Upgrade path: once 12 lands and Privy
 * test mode is decided, add a connectPrivyTestWallet() alongside
 * connectBurnerWallet() and branch on whether VITE_PRIVY_APP_ID is set.
 *
 * Not verified end to end: standing up the local validator, program,
 * backend and frontend together was out of scope for this pass (see ticket
 * 13's `## Comments`). Only `playwright test --list` proved this file
 * compiles and the test is discovered.
 */
import { expect, test, type Page } from "playwright/test";

/** Round length the target pool is running, for the settle-wait budget. Matches spec.md §7's 60s default; override for a faster demo pool (see the runbook's "changing epoch length" recipe, which also covers --round-seconds). */
const ROUND_SECONDS = Number(process.env.E2E_ROUND_SECONDS ?? 60);
const VRF_TIMEOUT_SECONDS = Number(process.env.E2E_VRF_TIMEOUT_SECONDS ?? 120);
/** Generous: a round can void and retry once before ORAO answers. */
const SETTLE_TIMEOUT_MS = (ROUND_SECONDS + VRF_TIMEOUT_SECONDS + 60) * 1000;
/** Same default as src/api.ts, so the spec's faucet call hits the app's backend. */
const API_URL = process.env.VITE_API_URL ?? "http://127.0.0.1:8080";

async function connectBurnerWallet(page: Page): Promise<void> {
  await page.goto("/");
  // HOME is the first screen now; these flows live on MINE.
  await page.getByTestId("tab-mine").click();
  await page.getByTestId("connect-button").click();
  // Standard wallet-adapter-react-ui modal. With VITE_BURNER_WALLET=1 and a
  // local RPC (see src/dev-burner.ts's isLocalRpc gate), the burner is the
  // only entry in the list.
  const burnerOption = page.getByRole("button", { name: /burner/i });
  if (await burnerOption.isVisible({ timeout: 5_000 }).catch(() => false)) {
    await burnerOption.click();
  }
  await expect(page.getByTestId("disconnect-button")).toBeVisible({
    timeout: 15_000,
  });
}

function parseAfterLabel(text: string, label: string): number {
  const match = new RegExp(`${label}\\s+([\\d.]+)`).exec(text);
  if (!match) {
    throw new Error(`could not find "${label}" in "${text}"`);
  }
  return Number(match[1]);
}

/** Clicks a tile until it reports selected. Tiles only respond once an open round is in its "mine" phase (see src/App.tsx's canPick). */
async function selectTile(page: Page, tileNumber: number): Promise<void> {
  const tile = page.getByTestId(`tile-${tileNumber}`);
  await expect(async () => {
    await tile.click();
    await expect(tile).toHaveAttribute("data-selected", "1");
  }).toPass({ timeout: 90_000 });
}

test("faucet, deposit, play a round, settle, withdraw the matched amount", async ({
  page,
}) => {
  await connectBurnerWallet(page);

  // 1. Faucet. Rate-limited is not a failure here (see api.ts's FaucetResult).
  // ponytail: the burner wallet is a fixed keypair, so a repeat run against
  // the same backend can legitimately hit the per-owner cooldown while
  // already holding hexUSDC from a previous run. This does not fix
  // repeatability properly; upgrade path is a fresh keypair per run, or a
  // backend reset endpoint, whichever ticket ends up owning CI for this spec.
  // The faucet button left the VAULT tab with the Figma redesign (it moves to
  // the navbar), so this hits POST /faucet directly with the connected address.
  const title = await page.getByTestId("connect-button").getAttribute("title");
  const owner = title?.replace(/^Copy /, "");
  expect(owner, "connect button carries the wallet address").toBeTruthy();
  const faucet = await page.request.post(`${API_URL}/faucet`, { data: { owner } });
  expect([200, 201, 429]).toContain(faucet.status());
  await page.getByTestId("tab-vault").click();

  // 2. Deposit 100 hexUSDC.
  await page.getByTestId("deposit-input").fill("100");
  const depositSubmit = page.getByTestId("deposit-submit");
  await expect(depositSubmit).toBeEnabled({ timeout: 15_000 });
  await depositSubmit.click();
  await expect(page.getByTestId("vault-note")).toContainText(/deposit confirmed/i, {
    timeout: 30_000,
  });

  // 3. Buy a position on 3 tiles.
  await page.getByTestId("tab-mine").click();
  const entriesBefore = parseAfterLabel(
    await page.getByTestId("wallet-entries").innerText(),
    "Tickets",
  );
  await page.getByTestId("stake-input").fill("1");
  await selectTile(page, 0);
  await selectTile(page, 1);
  await selectTile(page, 2);
  await expect(page.getByTestId("tile-count")).toHaveText("3");

  const deployButton = page.getByTestId("deploy");
  await expect(deployButton).toBeEnabled({ timeout: 10_000 });
  await deployButton.click();
  await expect(page.getByTestId("deploy-note")).toBeVisible({ timeout: 30_000 });

  // 4. Wait for the round to settle, then settle this position.
  await expect(page.getByTestId("reward-hint")).toBeVisible({
    timeout: SETTLE_TIMEOUT_MS,
  });
  await page.getByTestId("settle-position").click();
  await expect(page.getByTestId("deploy-note")).toContainText(/settled/i, {
    timeout: 30_000,
  });

  // 5. Entries changed (buying a position always spends some, win or lose),
  // and withdrawable shows min(Principal, Entries): product-requirements.md §3.1.
  const entriesAfter = parseAfterLabel(
    await page.getByTestId("wallet-entries").innerText(),
    "Tickets",
  );
  expect(entriesAfter).not.toBe(entriesBefore);

  await page.getByTestId("tab-vault").click();
  await page.getByTestId("vault-tab-withdraw").click();
  // "Available N tickets" is min(Principal, Tickets); lib/money.test.ts
  // covers the arithmetic, this only checks the number is live and positive.
  const shownWithdrawable = parseAfterLabel(
    await page.getByTestId("withdrawable-now").innerText(),
    "Available",
  );
  expect(shownWithdrawable).toBeGreaterThan(0);

  // 6. Withdraw the matched amount.
  await page.getByTestId("withdraw-input").fill(String(shownWithdrawable));
  const withdrawSubmit = page.getByTestId("withdraw-submit");
  await expect(withdrawSubmit).toBeEnabled();
  await withdrawSubmit.click();
  await expect(page.getByTestId("vault-note")).toContainText(
    /withdraw confirmed/i,
    { timeout: 30_000 },
  );
});
