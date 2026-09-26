import { describe, expect, it } from "vitest";

import { PROVIDER_HOSTS, findLeak } from "./check-bundle-keys.mjs";

const HEX_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const B64_KEY = "AbCdEfGhIjKlMnOpQrStUvWxYz012345";

const bundle = (text: string) => [{ path: "dist/assets/index.js", text }];

describe("findLeak", () => {
  it("flags a bundle carrying a keyed RPC URL", () => {
    const hit = findLeak(bundle('const RPC="https://x/?api-key=abc"'));
    expect(hit).toEqual({
      file: "dist/assets/index.js",
      pattern: "api-key query param",
    });
  });

  it("passes a clean bundle", () => {
    expect(findLeak(bundle('const RPC="https://api.devnet.solana.com"'))).toBeNull();
  });

  // Pre-mainnet review: the generic patterns, one keyed URL per provider
  // whose key sits in a path segment or a query param other than `api-key`.
  it.each([
    ["dRPC", `https://lb.drpc.org/ogrpc?network=solana&dkey=${B64_KEY}`, "dRPC key"],
    ["Ankr", `https://rpc.ankr.com/solana/${HEX_KEY}`, "Ankr token"],
    ["Shyft", `https://rpc.shyft.to?api_key=${B64_KEY}`, "Shyft key"],
    ["Syndica", `https://solana-mainnet.api.syndica.io/api-key/${B64_KEY}`, "Syndica key"],
    ["Chainstack", `https://solana-mainnet.core.chainstack.com/${HEX_KEY}`, "provider host with key-shaped token"],
    ["GetBlock", `https://go.getblock.io/${HEX_KEY}`, "provider host with key-shaped token"],
    ["Helius, with a lowercase host and a hex key", `https://mainnet.helius-rpc.com/?api-key=${HEX_KEY}`, "api-key query param"],
    ["a token= query param on any host", `https://rpc.example.com/?token=${B64_KEY}`, "keyed query param"],
    ["an apikey= query param on any host", `https://rpc.example.com/v1?apikey=${HEX_KEY}`, "keyed query param"],
  ])("flags a %s keyed URL", (_name, url, pattern) => {
    expect(findLeak(bundle(`const RPC="${url}";`))).toEqual({
      file: "dist/assets/index.js",
      pattern,
    });
  });

  it("flags a key-shaped token next to every listed provider host", () => {
    for (const host of PROVIDER_HOSTS) {
      expect(findLeak(bundle(`"https://rpc.${host}/${B64_KEY}"`)), host).not.toBeNull();
    }
  });

  it("passes the providers' public, unkeyed endpoints", () => {
    expect(
      findLeak(
        bundle(
          [
            '"https://rpc.ankr.com/solana"',
            '"https://lb.drpc.org/ogrpc?network=solana"',
            '"https://solana-mainnet.rpc.extrnode.com"',
            '"https://api.mainnet-beta.solana.com"',
            '"https://rpc.shyft.to"',
          ].join(","),
        ),
      ),
    ).toBeNull();
  });

  it("does not false-positive on ordinary bundle content", () => {
    // A base64 image, a hashed chunk name, a long hex hash and a `?ref=`
    // link: long tokens with no provider host or keyed param beside them.
    const dataUri =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
    const text = [
      `const img="${dataUri}";`,
      'import("./assets/index-BfK3x9Qz.js");',
      `const hash="${HEX_KEY}";`,
      'const link=`${origin}/?ref=ABCD2345`;',
      'const short="https://rpc.example.com/?token=abc";',
      'const tmpl="https://rpc.ankr.com/solana/${key}";',
    ].join("\n");
    expect(findLeak(bundle(text))).toBeNull();
  });

  it("does not run a provider host into the next string literal", () => {
    // The host's own URL ends at the quote; the key-shaped token that follows
    // belongs to an unrelated literal.
    expect(
      findLeak(bundle(`["https://rpc.ankr.com/solana","${B64_KEY}"]`)),
    ).toBeNull();
  });
});
