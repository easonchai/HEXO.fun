import { describe, expect, it } from "vitest";

import {
  EXIT_ASSERTION,
  EXIT_CHAIN,
  EXIT_USAGE,
  CliError,
  jsonRepr,
  renderText,
} from "./errors.js";

describe("exit codes", () => {
  it("distinguishes usage, chain and assertion failures", () => {
    expect(new CliError(EXIT_USAGE, "bad flag").code).toBe(2);
    expect(new CliError(EXIT_CHAIN, "rpc down").code).toBe(3);
    expect(new CliError(EXIT_ASSERTION, "verdict failed").code).toBe(4);
  });
});

describe("rendering", () => {
  it("renders bigints as strings and bytes as hex in JSON", () => {
    const text = jsonRepr({
      amount: 1000000n,
      root: new Uint8Array([0xde, 0xad]),
    });
    expect(text).toContain('"amount": "1000000"');
    expect(text).toContain('"root": "dead"');
  });

  it("renders indented key/value text", () => {
    const text = renderText({ pool: "P", vaults: [{ atomic: "5" }] });
    expect(text).toContain("pool: P");
    expect(text).toContain("vaults:");
    expect(text).toContain("atomic: 5");
  });
});
