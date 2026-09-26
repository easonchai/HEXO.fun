-- Mirrors the on-chain `Player.requested_at` (custody.rs's second way a
-- withdrawal request matures, `now > requested_at + epoch_seconds`), so the
-- web can offer PAY OUT NOW through the dead-operator hatch. Same shape as
-- 20260921120000: the deployed container runs `prisma migrate deploy` with
-- rows already in the table, so the column lands with a default and drops
-- it again; the next sync upserts the real value off chain.

-- AlterTable
ALTER TABLE "Player" ADD COLUMN     "requestedAt" BIGINT NOT NULL DEFAULT 0;
ALTER TABLE "Player" ALTER COLUMN "requestedAt" DROP DEFAULT;
