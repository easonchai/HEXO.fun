import { beforeAll, describe, expect, it } from "vitest";

import {
  HexVault,
  longTimeouts,
  type EpochWindow,
  type Pool,
} from "./helpers/hx.ts";

const AMT = 1_000_000n;
const MAX_EPOCH_SECONDS = 60 * 60 * 24 * 35;

describe("epoch lifecycle: window validation, sequencing, entry cutoff", () => {
  longTimeouts();

  let hv: HexVault;
  let pool: Pool;
  let now: number;
  let epoch1: EpochWindow;
  let cutoff: number;

  beforeAll(async () => {
    hv = await HexVault.create();
    pool = await hv.createPool();
    now = await hv.chainNow();
    epoch1 = {
      id: 1n,
      startsAt: now - 20,
      entryCutoffAt: now + 15,
      endsAt: now + 3_600,
      prizeSnapshotAt: now + 3_600,
      claimDeadline: now + 7_200,
    };
    cutoff = epoch1.entryCutoffAt;
    await hv.fundUsdc(hv.payer, AMT * 2n);
    await pool.createFirstEpoch(epoch1);
    await pool.deposit(hv.payer, AMT);
  });

  const timing = (overrides: Partial<EpochWindow>, id = 1n): EpochWindow => ({
    id,
    startsAt: now - 20,
    entryCutoffAt: now + 40,
    endsAt: now + 60,
    prizeSnapshotAt: now + 60,
    claimDeadline: now + 120,
    ...overrides,
  });

  it("rejects first epochs whose window ordering is violated", async () => {
    // each attempt uses a fresh epoch id: an invalid window reverts the whole
    // transaction, so the derived epoch account is never left behind
    // cutoff must be strictly after start
    await expect(
      pool.createFirstEpoch(timing({ entryCutoffAt: now - 20 }, 101n)),
    ).rejects.toThrow("InvalidTimeWindow");
    // cutoff must not run past the end
    await expect(
      pool.createFirstEpoch(timing({ entryCutoffAt: now + 70 }, 102n)),
    ).rejects.toThrow("InvalidTimeWindow");
    // snapshot must not precede the end
    await expect(
      pool.createFirstEpoch(timing({ prizeSnapshotAt: now + 59 }, 103n)),
    ).rejects.toThrow("InvalidTimeWindow");
    // deadline must not precede the snapshot
    await expect(
      pool.createFirstEpoch(timing({ claimDeadline: now + 59 }, 104n)),
    ).rejects.toThrow("InvalidTimeWindow");
  });

  it("rejects durations outside the pool bounds", async () => {
    await expect(
      pool.createFirstEpoch(
        timing(
          {
            entryCutoffAt: now - 19,
            endsAt: now - 18,
            prizeSnapshotAt: now - 18,
            claimDeadline: now - 10,
          },
          105n,
        ),
      ),
    ).rejects.toThrow("InvalidTimeWindow");

    await expect(
      pool.createFirstEpoch(
        timing(
          {
            entryCutoffAt: now + 100,
            endsAt: now - 20 + MAX_EPOCH_SECONDS + 1,
            prizeSnapshotAt: now - 20 + MAX_EPOCH_SECONDS + 1,
            claimDeadline: now - 20 + MAX_EPOCH_SECONDS + 2,
          },
          106n,
        ),
      ),
    ).rejects.toThrow("InvalidTimeWindow");
  });

  it("rejects duplicate first epochs before they can bypass active-epoch checks", async () => {
    await expect(pool.createFirstEpoch(timing({}, 2n))).rejects.toThrow(
      "FirstEpochAlreadyCreated",
    );
    expect((await pool.poolAccount()).latestEpochId.toNumber()).toBe(1);

    // The original epoch remains the only usable epoch after the rejected
    // duplicate creation attempt.
    await pool.withdraw(hv.payer, AMT);
    await pool.deposit(hv.payer, AMT);
  });

  it("rejects rollover epochs that are not sequential, too early, or after an unresolved prize", async () => {
    await expect(pool.beginNextEpoch(1n, timing({}, 3n))).rejects.toThrow(
      "NonSequentialEpoch",
    );

    // starts_at must not precede the prior epoch's end
    await expect(
      pool.beginNextEpoch(1n, timing({ startsAt: now - 1 }, 2n)),
    ).rejects.toThrow("InvalidTimeWindow");

    // the prior epoch is still open: prize and jackpot are unresolved
    await expect(
      pool.beginNextEpoch(
        1n,
        timing(
          {
            startsAt: epoch1.endsAt,
            entryCutoffAt: epoch1.endsAt + 10,
            endsAt: epoch1.endsAt + 20,
            prizeSnapshotAt: epoch1.endsAt + 20,
            claimDeadline: epoch1.endsAt + 40,
          },
          2n,
        ),
      ),
    ).rejects.toThrow("PriorEpochUnresolved");

    expect((await pool.poolAccount()).latestEpochId.toNumber()).toBe(1);
  });

  it("rejects a second entry refresh inside the same epoch", async () => {
    await expect(pool.refresh(hv.payer)).rejects.toThrow(
      "EntriesAlreadyRefreshed",
    );
  });

  it("rejects deposits and refreshes at or after the entry cutoff", async () => {
    await hv.waitUntil(cutoff + 1);

    await expect(pool.deposit(hv.payer, AMT)).rejects.toThrow("EpochNotOpen");
    await expect(pool.refresh(hv.payer)).rejects.toThrow("EpochNotOpen");

    // withdrawal is deliberately independent of the epoch window
    await pool.withdraw(hv.payer, AMT);
    expect(await pool.vaultBalance(pool.principalVault)).toBe(0n);
  });
});
