/**
 * Browser shim: the Solana stack expects the Node `Buffer` global, which Vite
 * does not inject. Import this module FIRST so it runs before any Solana code.
 */
import { Buffer } from "buffer";

if (typeof globalThis.Buffer === "undefined") {
  globalThis.Buffer = Buffer;
}

export {};
