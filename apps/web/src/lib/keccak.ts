/**
 * Keccak-256 (original Keccak padding, 0x01 ... 0x80) — the variant used by
 * Solana's `solana_keccak_hasher::hashv` and by Ethereum. This is NOT
 * NIST SHA3-256, which pads with 0x06 and would produce different roots than
 * the on-chain program.
 *
 * Copied verbatim from packages/indexer/src/keccak.ts minus its Node-only
 * `sha3_256Reference` test oracle, so this module is browser-pure. Any change
 * here must land in the indexer copy in the same commit.
 */

const ROUND_CONSTANTS = [
  0x0000000000000001n,
  0x0000000000008082n,
  0x800000000000808an,
  0x8000000080008000n,
  0x000000000000808bn,
  0x0000000080000001n,
  0x8000000080008081n,
  0x8000000000008009n,
  0x000000000000008an,
  0x0000000000000088n,
  0x0000000080008009n,
  0x000000008000000an,
  0x000000008000808bn,
  0x800000000000008bn,
  0x8000000000008089n,
  0x8000000000008003n,
  0x8000000000008002n,
  0x8000000000000080n,
  0x000000000000800an,
  0x800000008000000an,
  0x8000000080008081n,
  0x8000000000008080n,
  0x0000000080000001n,
  0x8000000080008008n,
];

const RHO_OFFSETS = [
  1, 3, 6, 10, 15, 21, 28, 36, 45, 55, 2, 14, 27, 41, 56, 8, 25, 43, 62, 18, 39,
  61, 20, 44,
];

const PI_LANES = [
  10, 7, 11, 17, 18, 3, 5, 16, 8, 21, 24, 4, 15, 23, 19, 13, 12, 2, 20, 14, 22,
  9, 6, 1,
];

const MASK64 = (1n << 64n) - 1n;
const RATE_BYTES = 136; // 1600 - 2*256 bits
const WORD = (value: bigint, shift: number): bigint =>
  ((value << BigInt(shift)) | (value >> BigInt(64 - shift))) & MASK64;

function keccakF1600(state: bigint[]): void {
  for (let round = 0; round < 24; round += 1) {
    const parity = new Array<bigint>(5);
    for (let x = 0; x < 5; x += 1) {
      parity[x] =
        state[x]! ^
        state[x + 5]! ^
        state[x + 10]! ^
        state[x + 15]! ^
        state[x + 20]!;
    }
    for (let x = 0; x < 5; x += 1) {
      const d = parity[(x + 4) % 5]! ^ WORD(parity[(x + 1) % 5]!, 1);
      for (let y = 0; y < 25; y += 5)
        state[y + x] = (state[y + x]! ^ d) & MASK64;
    }

    let carried = state[1]!;
    for (let i = 0; i < 24; i += 1) {
      const lane = PI_LANES[i]!;
      const next = state[lane]!;
      state[lane] = WORD(carried, RHO_OFFSETS[i]!);
      carried = next;
    }

    for (let y = 0; y < 25; y += 5) {
      const row = [
        state[y]!,
        state[y + 1]!,
        state[y + 2]!,
        state[y + 3]!,
        state[y + 4]!,
      ];
      for (let x = 0; x < 5; x += 1) {
        state[y + x] =
          (row[x]! ^ (~row[(x + 1) % 5]! & row[(x + 2) % 5]!)) & MASK64;
      }
    }

    state[0] = (state[0]! ^ ROUND_CONSTANTS[round]!) & MASK64;
  }
}

const lanesToState = (block: Uint8Array): bigint[] => {
  const state = new Array<bigint>(25).fill(0n);
  const lanes = block.length / 8;
  for (let lane = 0; lane < lanes; lane += 1) {
    let value = 0n;
    for (let byte = 7; byte >= 0; byte -= 1) {
      value = (value << 8n) | BigInt(block[lane * 8 + byte]!);
    }
    state[lane] = value & MASK64;
  }
  return state;
};

export function keccak256(input: Uint8Array): Buffer {
  const paddedLength = (Math.floor(input.length / RATE_BYTES) + 1) * RATE_BYTES;
  const padded = new Uint8Array(paddedLength);
  padded.set(input);
  padded[input.length]! ^= 0x01; // Keccak multi-rate pad, distinct from SHA3's 0x06
  padded[paddedLength - 1]! ^= 0x80;

  const state = new Array<bigint>(25).fill(0n);
  for (let offset = 0; offset < paddedLength; offset += RATE_BYTES) {
    const block = lanesToState(padded.subarray(offset, offset + RATE_BYTES));
    for (let lane = 0; lane < 25; lane += 1)
      state[lane] = (state[lane]! ^ block[lane]!) & MASK64;
    keccakF1600(state);
  }

  const digest = Buffer.alloc(32);
  for (let byte = 0; byte < 32; byte += 1) {
    digest[byte] = Number(
      (state[Math.floor(byte / 8)]! >> BigInt(8 * (byte % 8))) & 0xffn,
    );
  }
  return digest;
}

/** Rust `hashv(&[parts...])`: keccak256 over the concatenated parts. */
export function keccak256Concat(...parts: Uint8Array[]): Buffer {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    joined.set(part, offset);
    offset += part.length;
  }
  return keccak256(joined);
}
