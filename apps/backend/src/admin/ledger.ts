// Ledger hardware signing for the admin CLI (ticket 09, spec.md "Ledger").
// ADMIN_KEYPAIR=usb://ledger[?key=N] moves the admin's signature off
// chain.keypair (the operator's hot key, the only signer the CLI had before
// this ticket) and onto a Ledger. Everything downstream in index.ts still
// treats the result as a plain `{ publicKey, signTransaction }` signer.
//
// The transport is injected as `LedgerTransport` (the slice of
// @ledgerhq/hw-app-solana's `Solana` class this file calls), so a unit test
// drives it with a fake device instead of real hardware. The real
// `@ledgerhq/hw-app-solana` and `@ledgerhq/hw-transport-node-hid` packages
// are only imported from index.ts's `main()`, and only once ADMIN_KEYPAIR
// actually asks for a Ledger, so importing this module never touches USB.
import { PublicKey, type Transaction } from "@solana/web3.js";

/** `{ publicKey, signTransaction }`: as much of a signer as `submit()` needs,
 *  whether it is backed by a Ledger or the loaded keypair. */
export interface AdminSigner {
  readonly publicKey: PublicKey;
  signTransaction(tx: Transaction): Promise<Transaction>;
}

/** The slice of `@ledgerhq/hw-app-solana`'s `Solana` class this file calls. */
export interface LedgerTransport {
  getAddress(path: string): Promise<{ address: Uint8Array }>;
  signTransaction(
    path: string,
    message: Uint8Array,
  ): Promise<{ signature: Uint8Array }>;
}

/** Same default derivation as the `solana` CLI's `usb://ledger?key=N`
 *  (`account` defaults to 0). */
export function ledgerDerivationPath(account: number): string {
  return `44'/501'/${account}'`;
}

export type AdminKeypairSelector =
  | { readonly ledger: true; readonly account: number }
  | { readonly ledger: false };

/**
 * Parses `ADMIN_KEYPAIR`. Unset, or any value that is not a `usb://ledger`
 * URI, means "sign locally with the loaded keypair" — the only behaviour
 * that existed before this ticket, so a deployment that never sets this var
 * needs no change.
 */
export function parseAdminKeypair(raw: string | undefined): AdminKeypairSelector {
  if (raw === undefined) return { ledger: false };
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ledger: false };
  }
  if (url.protocol !== "usb:" || url.hostname !== "ledger") return { ledger: false };
  const keyParam = url.searchParams.get("key");
  if (keyParam === null) return { ledger: true, account: 0 };
  if (!/^\d+$/.test(keyParam)) {
    throw new Error(
      `ADMIN_KEYPAIR's ?key must be a non-negative whole number, got "${keyParam}"`,
    );
  }
  return { ledger: true, account: Number(keyParam) };
}

/**
 * Builds the Ledger-backed signer. Derives the pubkey once, up front — the
 * one round trip every command needs anyway, to fail closed against
 * `ADMIN_ADDRESS` before a transaction exists — and reuses it for every
 * `signTransaction` call this process makes.
 */
export async function ledgerSigner(
  transport: LedgerTransport,
  account: number,
): Promise<AdminSigner> {
  const path = ledgerDerivationPath(account);
  const { address } = await transport.getAddress(path);
  const publicKey = new PublicKey(address);
  return {
    publicKey,
    async signTransaction(tx: Transaction): Promise<Transaction> {
      const { signature } = await transport.signTransaction(path, tx.serializeMessage());
      tx.addSignature(publicKey, Buffer.from(signature));
      return tx;
    },
  };
}

/**
 * Fails closed when the Ledger is loaded under a different key than
 * `ADMIN_ADDRESS` names. Without this, a wrong `?key=N` or a stray device
 * would fall through to `adminMode`'s ordinary "not the loaded key" branch,
 * which prints an unsigned transaction for Squads instead of telling the
 * operator their Ledger disagrees with the configured admin — the wrong
 * failure mode for a plain misconfiguration. `adminAddress` absent skips the
 * check: nothing to compare against yet, so the Ledger key becomes the admin
 * (same "absent means the loaded key is the admin too" rule as before).
 */
export function checkLedgerAddress(
  ledgerPubkey: PublicKey,
  adminAddress: string | undefined,
): void {
  if (!adminAddress) return;
  if (ledgerPubkey.toBase58() === adminAddress) return;
  throw new Error(
    `Ledger key ${ledgerPubkey.toBase58()} does not match ADMIN_ADDRESS ${adminAddress}; check the account (?key=N) or the device`,
  );
}
