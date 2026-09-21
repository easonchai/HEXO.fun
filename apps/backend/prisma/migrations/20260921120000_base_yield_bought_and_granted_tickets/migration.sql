-- Base yield, bought tickets and granted tickets (docs/plan/hexo-referrals
-- tickets 01-04). Same shape as 20260920020000: the deployed container runs
-- `prisma migrate deploy` with rows already in the tables, so each new
-- column lands with a default and drops it again. Those placeholders live
-- for one indexer tick; the next sync upserts the real values off chain.

-- AlterTable
ALTER TABLE "Pool" ADD COLUMN     "baseRateBps" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Pool" ALTER COLUMN "baseRateBps" DROP DEFAULT;
ALTER TABLE "Pool" ADD COLUMN     "yieldBudget" BIGINT NOT NULL DEFAULT 0;
ALTER TABLE "Pool" ALTER COLUMN "yieldBudget" DROP DEFAULT;
ALTER TABLE "Pool" ADD COLUMN     "ticketsPerUsdc" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Pool" ALTER COLUMN "ticketsPerUsdc" DROP DEFAULT;
ALTER TABLE "Pool" ADD COLUMN     "bonusCapBps" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Pool" ALTER COLUMN "bonusCapBps" DROP DEFAULT;
ALTER TABLE "Pool" ADD COLUMN     "bonusEpoch" BIGINT NOT NULL DEFAULT 0;
ALTER TABLE "Pool" ALTER COLUMN "bonusEpoch" DROP DEFAULT;
ALTER TABLE "Pool" ADD COLUMN     "bonusGranted" BIGINT NOT NULL DEFAULT 0;
ALTER TABLE "Pool" ALTER COLUMN "bonusGranted" DROP DEFAULT;

-- AlterTable
ALTER TABLE "Player" ADD COLUMN     "principalAcc" DECIMAL(40,0) NOT NULL DEFAULT 0;
ALTER TABLE "Player" ALTER COLUMN "principalAcc" DROP DEFAULT;
ALTER TABLE "Player" ADD COLUMN     "frozenPrincipalAcc" DECIMAL(40,0) NOT NULL DEFAULT 0;
ALTER TABLE "Player" ALTER COLUMN "frozenPrincipalAcc" DROP DEFAULT;
ALTER TABLE "Player" ADD COLUMN     "yieldEpoch" BIGINT NOT NULL DEFAULT 0;
ALTER TABLE "Player" ALTER COLUMN "yieldEpoch" DROP DEFAULT;
ALTER TABLE "Player" ADD COLUMN     "boughtEpoch" BIGINT NOT NULL DEFAULT 0;
ALTER TABLE "Player" ALTER COLUMN "boughtEpoch" DROP DEFAULT;
ALTER TABLE "Player" ADD COLUMN     "boughtAmount" BIGINT NOT NULL DEFAULT 0;
ALTER TABLE "Player" ALTER COLUMN "boughtAmount" DROP DEFAULT;
ALTER TABLE "Player" ADD COLUMN     "bonusEpoch" BIGINT NOT NULL DEFAULT 0;
ALTER TABLE "Player" ALTER COLUMN "bonusEpoch" DROP DEFAULT;
ALTER TABLE "Player" ADD COLUMN     "bonusGranted" BIGINT NOT NULL DEFAULT 0;
ALTER TABLE "Player" ALTER COLUMN "bonusGranted" DROP DEFAULT;
