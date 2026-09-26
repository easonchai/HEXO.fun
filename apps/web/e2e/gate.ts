/**
 * Shared invite-gate helper for the Playwright specs (pre-mainnet review).
 * Every page load lands under the gate overlay (src/AccessGate.tsx, a
 * fixed full-page modal) until `GET /access/:wallet` says the connected
 * wallet is allowed, so a spec that clicks anything has to get past it
 * first. Two ways through, picked by the environment:
 *
 * - `E2E_INVITE_ADMIN_KEY` set: mint a fresh single-use Invite code through
 *   the backend's `POST /access/invites` (apps/backend/src/api/
 *   access.controller.ts: header `x-admin-key`, JSON body `{ count: 1 }`,
 *   answer `{ codes: [code] }`; the route 404s unless the backend has
 *   `INVITE_ADMIN_KEY` set) and submit it through the gate. SUBMIT opens
 *   the wallet modal first when nothing is connected, then signs
 *   `HEXO access: <wallet> <CODE>` with the burner and redeems.
 * - Otherwise: the gate's "Already have access? Connect wallet" button,
 *   which connects without a code. The check then passes for a wallet that
 *   already redeemed or deposited (the burner after any earlier demo run
 *   against the same backend); a never-seen wallet stays gated and the
 *   assertion at the end says so.
 *
 * Not a spec: Playwright's default testMatch is `*.spec.ts`, so this file
 * is only ever imported.
 */
import { expect, type Page } from "playwright/test";

/** Where the backend answers; the app's own default (src/chain.ts API_URL). */
const API_URL = process.env.E2E_API_URL ?? "http://127.0.0.1:8080";

/** Picks the burner in the wallet-adapter modal when it is offered
 *  (VITE_BURNER_WALLET=1 against a local RPC makes it the only entry). */
async function pickBurnerIfOffered(page: Page): Promise<void> {
  const burnerOption = page.getByRole("button", { name: /burner/i });
  if (await burnerOption.isVisible({ timeout: 5_000 }).catch(() => false)) {
    await burnerOption.click();
  }
}

async function mintInviteCode(page: Page, adminKey: string): Promise<string> {
  const response = await page.request.post(`${API_URL}/access/invites`, {
    headers: { "x-admin-key": adminKey },
    data: { count: 1 },
  });
  expect(response.ok(), `POST /access/invites answered ${response.status()}`).toBe(true);
  const body = (await response.json()) as { codes?: string[] };
  const code = body.codes?.[0];
  if (!code) throw new Error(`POST /access/invites returned no code: ${JSON.stringify(body)}`);
  return code;
}

/**
 * Gets the page past the invite gate, connecting the burner wallet on the
 * way. Call it right after `page.goto`. A no-op when the gate is not up
 * (already passed earlier in the same page).
 */
export async function passAccessGate(page: Page): Promise<void> {
  const gate = page.getByTestId("access-gate");
  if (!(await gate.isVisible({ timeout: 5_000 }).catch(() => false))) return;

  const adminKey = process.env.E2E_INVITE_ADMIN_KEY;
  if (adminKey) {
    const code = await mintInviteCode(page, adminKey);
    await page.getByTestId("access-gate-input").fill(code);
    await page.getByTestId("access-gate-submit").click();
    await pickBurnerIfOffered(page);
  } else {
    await page.getByTestId("access-gate-connect").click();
    await pickBurnerIfOffered(page);
  }

  // Connected: the topbar pill carries `Copy <address>`.
  await expect(page.getByTestId("connect-button")).toHaveAttribute("title", /^Copy /, {
    timeout: 15_000,
  });
  await expect(
    gate,
    adminKey
      ? "the gate stayed up after redeeming a freshly minted code"
      : "the gate stayed up: this wallet has never redeemed or deposited; set E2E_INVITE_ADMIN_KEY to mint it a code",
  ).toHaveCount(0, { timeout: 30_000 });
}
