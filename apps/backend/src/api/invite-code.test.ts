import { sign as signEd25519, createPrivateKey } from "node:crypto";

import { Keypair, PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";

import {
  accessMessage,
  applyReferralMessage,
  generateInviteCode,
  INVITE_CIRCULATION_CAP,
  INVITE_CODE_ALPHABET,
  INVITE_CODE_LENGTH,
  inviteGrantCount,
  INVITE_REDEEM_GRANT_COUNT,
  normalizeInviteCode,
  verifyAccessSignature,
  verifyApplyReferralSignature,
} from "./invite-code";

/** Signs with a Solana keypair's own seed, mirroring what a wallet's
 *  `signMessage` does, so the verifier is exercised against a real Ed25519
 *  signature rather than a fixture. */
function sign(keypair: Keypair, message: string): Uint8Array {
  const seed = Buffer.from(keypair.secretKey.subarray(0, 32));
  const x = Buffer.from(keypair.publicKey.toBytes()).toString("base64url");
  const key = createPrivateKey({
    key: { kty: "OKP", crv: "Ed25519", d: seed.toString("base64url"), x },
    format: "jwk",
  });
  return signEd25519(null, Buffer.from(message, "utf8"), key);
}

describe("generateInviteCode", () => {
  it("is 8 characters from the unambiguous alphabet", () => {
    for (let i = 0; i < 50; i++) {
      const code = generateInviteCode();
      expect(code).toHaveLength(INVITE_CODE_LENGTH);
      for (const char of code) {
        expect(INVITE_CODE_ALPHABET).toContain(char);
      }
    }
  });

  it("never contains 0, O, 1 or I", () => {
    for (let i = 0; i < 200; i++) {
      const code = generateInviteCode();
      expect(code).not.toMatch(/[0O1I]/);
    }
  });
});

describe("inviteGrantCount", () => {
  it("grants the full INVITE_REDEEM_GRANT_COUNT with headroom to spare", () => {
    expect(inviteGrantCount(0)).toBe(2);
    expect(inviteGrantCount(48)).toBe(2);
  });

  it("grants only what fits under the cap", () => {
    expect(inviteGrantCount(49)).toBe(1);
  });

  it("grants none exactly at the cap", () => {
    expect(inviteGrantCount(INVITE_CIRCULATION_CAP)).toBe(0);
  });

  it("grants none over the cap, never a negative count", () => {
    expect(inviteGrantCount(51)).toBe(0);
    expect(inviteGrantCount(1000)).toBe(0);
  });

  it("never grants more than INVITE_REDEEM_GRANT_COUNT", () => {
    expect(inviteGrantCount(-100)).toBe(INVITE_REDEEM_GRANT_COUNT);
  });
});

describe("normalizeInviteCode", () => {
  it("upper-cases and trims, so redeem is case-insensitive on input", () => {
    expect(normalizeInviteCode("  abcd2345  ")).toBe("ABCD2345");
    expect(normalizeInviteCode("AbCd2345")).toBe("ABCD2345");
  });
});

describe("accessMessage", () => {
  it("is unchanged with no referral code (ticket 02: the old message stays valid)", () => {
    expect(accessMessage("Ai1ce", "ABC123XY")).toBe("HEXO access: Ai1ce ABC123XY");
  });

  it("carries the referral code inside the same message when given", () => {
    expect(accessMessage("Ai1ce", "ABC123XY", "REFC2345")).toBe(
      "HEXO access: Ai1ce ABC123XY ref:REFC2345",
    );
  });
});

describe("verifyAccessSignature", () => {
  it("accepts a wallet's own signature over the fixed message", () => {
    const wallet = Keypair.generate();
    const code = "ABCD2345";
    const signature = sign(wallet, accessMessage(wallet.publicKey.toBase58(), code));
    expect(verifyAccessSignature(wallet.publicKey, code, signature)).toBe(true);
  });

  it("accepts a signature over the message with a referral code, only when the referral code is passed back in", () => {
    const wallet = Keypair.generate();
    const code = "ABCD2345";
    const signature = sign(
      wallet,
      accessMessage(wallet.publicKey.toBase58(), code, "REFC2345"),
    );
    expect(verifyAccessSignature(wallet.publicKey, code, signature, "REFC2345")).toBe(true);
    expect(verifyAccessSignature(wallet.publicKey, code, signature)).toBe(false);
  });

  it("rejects a signature from a different wallet", () => {
    const wallet = Keypair.generate();
    const impostor = Keypair.generate();
    const code = "ABCD2345";
    const signature = sign(impostor, accessMessage(wallet.publicKey.toBase58(), code));
    expect(verifyAccessSignature(wallet.publicKey, code, signature)).toBe(false);
  });

  it("rejects a signature over a different code", () => {
    const wallet = Keypair.generate();
    const signature = sign(wallet, accessMessage(wallet.publicKey.toBase58(), "AAAA2222"));
    expect(verifyAccessSignature(wallet.publicKey, "BBBB3333", signature)).toBe(false);
  });

  it("rejects a tampered signature", () => {
    const wallet = Keypair.generate();
    const code = "ABCD2345";
    const signature = sign(wallet, accessMessage(wallet.publicKey.toBase58(), code));
    signature[0] = (signature[0] as number) ^ 0xff;
    expect(verifyAccessSignature(wallet.publicKey, code, signature)).toBe(false);
  });

  it("rejects garbage bytes instead of a real signature", () => {
    const wallet = Keypair.generate();
    expect(
      verifyAccessSignature(wallet.publicKey, "ABCD2345", new Uint8Array(64)),
    ).toBe(false);
  });

  it("never throws on an off-curve wallet address", () => {
    // A PDA's bytes are not a valid Ed25519 point; the verifier must fail
    // closed, not throw.
    const offCurve = PublicKey.findProgramAddressSync(
      [Buffer.from("not-a-wallet")],
      PublicKey.default,
    )[0];
    expect(() =>
      verifyAccessSignature(offCurve, "ABCD2345", new Uint8Array(64)),
    ).not.toThrow();
    expect(verifyAccessSignature(offCurve, "ABCD2345", new Uint8Array(64))).toBe(false);
  });
});

describe("applyReferralMessage", () => {
  it("is distinct from accessMessage (ADR 0014: not replayable as a redeem signature)", () => {
    expect(applyReferralMessage("Ai1ce", "ABC123XY")).toBe(
      "HEXO apply referral: Ai1ce ABC123XY",
    );
    expect(applyReferralMessage("Ai1ce", "ABC123XY")).not.toBe(
      accessMessage("Ai1ce", "ABC123XY"),
    );
  });
});

describe("verifyApplyReferralSignature", () => {
  it("accepts a wallet's own signature over the fixed message", () => {
    const wallet = Keypair.generate();
    const code = "ABCD2345";
    const signature = sign(wallet, applyReferralMessage(wallet.publicKey.toBase58(), code));
    expect(verifyApplyReferralSignature(wallet.publicKey, code, signature)).toBe(true);
  });

  it("rejects a redeem signature replayed as an apply signature", () => {
    const wallet = Keypair.generate();
    const code = "ABCD2345";
    const signature = sign(wallet, accessMessage(wallet.publicKey.toBase58(), code));
    expect(verifyApplyReferralSignature(wallet.publicKey, code, signature)).toBe(false);
  });

  it("rejects a signature from a different wallet", () => {
    const wallet = Keypair.generate();
    const impostor = Keypair.generate();
    const code = "ABCD2345";
    const signature = sign(impostor, applyReferralMessage(wallet.publicKey.toBase58(), code));
    expect(verifyApplyReferralSignature(wallet.publicKey, code, signature)).toBe(false);
  });
});
