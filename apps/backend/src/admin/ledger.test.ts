// Hardware is unavailable here (ticket 09), so this drives `ledgerSigner`
// with a fake `LedgerTransport` instead of a real device, and checks the
// three things that don't need one: usb:// parsing, the address-mismatch
// guard, and the signing adapter's wiring (right path, right message, the
// signature lands at the Ledger key's slot).
import {
  Keypair,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import { describe, expect, it } from "vitest";

import {
  checkLedgerAddress,
  ledgerDerivationPath,
  ledgerSigner,
  parseAdminKeypair,
  type LedgerTransport,
} from "./ledger";

describe("parseAdminKeypair", () => {
  it("treats an unset ADMIN_KEYPAIR as local signing", () => {
    expect(parseAdminKeypair(undefined)).toEqual({ ledger: false });
  });

  it("treats a base58 secret, not a URI, as local signing", () => {
    expect(
      parseAdminKeypair("5Kb8kLf9zgWQnogidDA76MzPL6TsZZY36hWXMssSzNydYXYB9KF"),
    ).toEqual({ ledger: false });
  });

  it("treats an unrelated URI as local signing", () => {
    expect(parseAdminKeypair("usb://other-device")).toEqual({ ledger: false });
    expect(parseAdminKeypair("http://ledger")).toEqual({ ledger: false });
  });

  it("parses usb://ledger with the default account", () => {
    expect(parseAdminKeypair("usb://ledger")).toEqual({ ledger: true, account: 0 });
  });

  it("parses usb://ledger?key=N", () => {
    expect(parseAdminKeypair("usb://ledger?key=3")).toEqual({ ledger: true, account: 3 });
  });

  it("rejects a non-numeric, empty or negative ?key", () => {
    expect(() => parseAdminKeypair("usb://ledger?key=abc")).toThrow(
      /non-negative whole number/,
    );
    expect(() => parseAdminKeypair("usb://ledger?key=")).toThrow(
      /non-negative whole number/,
    );
    expect(() => parseAdminKeypair("usb://ledger?key=-1")).toThrow(
      /non-negative whole number/,
    );
  });
});

describe("ledgerDerivationPath", () => {
  it("matches the solana CLI's usb://ledger?key=N default", () => {
    expect(ledgerDerivationPath(0)).toBe("44'/501'/0'");
    expect(ledgerDerivationPath(3)).toBe("44'/501'/3'");
  });
});

/** Enough of a fake Ledger to drive `ledgerSigner` without hardware: a fixed
 *  pubkey, a canned signature, and a record of what it was asked to sign. */
function fakeTransport(
  pubkeyBytes: Uint8Array,
  signature: Uint8Array,
): LedgerTransport & { readonly signed: { path: string; message: Uint8Array }[] } {
  const signed: { path: string; message: Uint8Array }[] = [];
  return {
    signed,
    async getAddress() {
      return { address: pubkeyBytes };
    },
    async signTransaction(path: string, message: Uint8Array) {
      signed.push({ path, message });
      return { signature };
    },
  };
}

describe("ledgerSigner", () => {
  it("derives the pubkey from the given account's path", async () => {
    const ledgerKey = Keypair.generate().publicKey;
    const transport = fakeTransport(ledgerKey.toBytes(), new Uint8Array(64));

    const signer = await ledgerSigner(transport, 7);

    expect(signer.publicKey.equals(ledgerKey)).toBe(true);
  });

  it("signs the transaction's message on the derived path and attaches the signature at the Ledger key's slot", async () => {
    const ledgerKey = Keypair.generate().publicKey;
    const fakeSignature = new Uint8Array(64).fill(9);
    const transport = fakeTransport(ledgerKey.toBytes(), fakeSignature);
    const signer = await ledgerSigner(transport, 0);

    const ix = new TransactionInstruction({
      programId: SystemProgram.programId,
      keys: [{ pubkey: ledgerKey, isSigner: true, isWritable: true }],
      data: Buffer.from([1]),
    });
    const tx = new Transaction({
      feePayer: ledgerKey,
      blockhash: Keypair.generate().publicKey.toBase58(),
      lastValidBlockHeight: 1,
    }).add(ix);
    const expectedMessage = tx.serializeMessage();

    const signed = await signer.signTransaction(tx);

    expect(transport.signed).toHaveLength(1);
    expect(transport.signed[0]?.path).toBe("44'/501'/0'");
    expect(transport.signed[0]?.message).toEqual(expectedMessage);
    const entry = signed.signatures.find((s) => s.publicKey.equals(ledgerKey));
    expect(entry?.signature).toEqual(Buffer.from(fakeSignature));
  });
});

describe("checkLedgerAddress", () => {
  it("passes when ADMIN_ADDRESS is unset or empty", () => {
    const key = Keypair.generate().publicKey;
    expect(() => checkLedgerAddress(key, undefined)).not.toThrow();
    expect(() => checkLedgerAddress(key, "")).not.toThrow();
  });

  it("passes when the Ledger key matches ADMIN_ADDRESS", () => {
    const key = Keypair.generate().publicKey;
    expect(() => checkLedgerAddress(key, key.toBase58())).not.toThrow();
  });

  it("fails closed when the Ledger key does not match ADMIN_ADDRESS", () => {
    const key = Keypair.generate().publicKey;
    const other = Keypair.generate().publicKey;
    expect(() => checkLedgerAddress(key, other.toBase58())).toThrow(
      /does not match ADMIN_ADDRESS/,
    );
  });
});
