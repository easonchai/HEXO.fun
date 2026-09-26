import { verifySignature } from "@solana/kit";
import { describe, expect, it } from "vitest";

import { burnerKeypair, burnerEnabled, isLocalRpc, signMessageWithKeypair } from "./dev-burner.js";

/**
 * The burner is an in-page keypair, so its gate is a security boundary. It
 * replaced a VITE_CLUSTER check, which no longer exists: the RPC endpoint is
 * now the only thing that says "this is a local validator".
 */
describe("dev burner gate", () => {
  it("recognises a local validator endpoint, and only that", () => {
    expect(isLocalRpc("http://127.0.0.1:8899")).toBe(true);
    expect(isLocalRpc("http://localhost:8899")).toBe(true);
    // No endpoint set: chain.ts defaults to the local validator.
    expect(isLocalRpc(undefined)).toBe(true);
    expect(isLocalRpc("   ")).toBe(true);
    expect(isLocalRpc("https://api.devnet.solana.com")).toBe(false);
    expect(isLocalRpc("https://devnet.helius-rpc.com/?api-key=x")).toBe(false);
    // A hostname that merely contains "localhost" is not localhost.
    expect(isLocalRpc("https://localhost.evil.example")).toBe(false);
  });

  it("needs the opt-in flag as well as the local endpoint", () => {
    const local = "http://127.0.0.1:8899";
    expect(
      burnerEnabled({ VITE_BURNER_WALLET: "1", VITE_PUBLIC_RPC_URL: local }),
    ).toBe(true);
    expect(burnerEnabled({ VITE_PUBLIC_RPC_URL: local })).toBe(false);
    expect(
      burnerEnabled({ VITE_BURNER_WALLET: "0", VITE_PUBLIC_RPC_URL: local }),
    ).toBe(false);
    expect(
      burnerEnabled({
        VITE_BURNER_WALLET: "1",
        VITE_PUBLIC_RPC_URL: "https://api.devnet.solana.com",
      }),
    ).toBe(false);
  });
});

describe("burner signMessage", () => {
  it("signs a message the burner's own public key verifies", async () => {
    // What the invite gate and the `?ref=` apply hand a wallet; without
    // this the burner could not get past the gate in the Playwright specs.
    const keypair = burnerKeypair();
    const message = new TextEncoder().encode(`HEXO access: ${keypair.publicKey.toBase58()} ABCD2345`);
    const signature = await signMessageWithKeypair(keypair, message);
    expect(signature).toHaveLength(64);
    const publicKey = await crypto.subtle.importKey(
      "raw",
      new Uint8Array(keypair.publicKey.toBytes()),
      { name: "Ed25519" },
      true,
      ["verify"],
    );
    expect(await verifySignature(publicKey, signature as never, message)).toBe(true);
    expect(await verifySignature(publicKey, signature as never, new Uint8Array([1]))).toBe(false);
  });
});
