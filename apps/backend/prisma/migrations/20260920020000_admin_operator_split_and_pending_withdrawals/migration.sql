-- The pool authority became an admin and an operator key, and both the Pool
-- and the Player now carry the epoch-locked withdrawal fields. Same shape as
-- 20260914061500: the deployed container runs `prisma migrate deploy` with
-- rows already in the tables, so each new column lands with a default and
-- drops it again. Those placeholders live for one indexer tick; the next
-- `syncAccounts` upserts the real values off chain.

-- AlterTable
ALTER TABLE "Pool" RENAME COLUMN "authority" TO "operator";
ALTER TABLE "Pool" ADD COLUMN     "admin" TEXT NOT NULL DEFAULT '';
ALTER TABLE "Pool" ALTER COLUMN "admin" DROP DEFAULT;
ALTER TABLE "Pool" ADD COLUMN     "pendingAdmin" TEXT;
ALTER TABLE "Pool" ADD COLUMN     "pendingWithdrawals" BIGINT NOT NULL DEFAULT 0;
ALTER TABLE "Pool" ALTER COLUMN "pendingWithdrawals" DROP DEFAULT;
ALTER TABLE "Pool" ADD COLUMN     "minJackpot" BIGINT NOT NULL DEFAULT 0;
ALTER TABLE "Pool" ALTER COLUMN "minJackpot" DROP DEFAULT;

-- AlterTable
ALTER TABLE "Player" ADD COLUMN     "pendingWithdraw" BIGINT NOT NULL DEFAULT 0;
ALTER TABLE "Player" ALTER COLUMN "pendingWithdraw" DROP DEFAULT;
ALTER TABLE "Player" ADD COLUMN     "pendingEpoch" BIGINT NOT NULL DEFAULT 0;
ALTER TABLE "Player" ALTER COLUMN "pendingEpoch" DROP DEFAULT;

-- AlterTable
ALTER TABLE "OperatorState" ADD COLUMN     "withdrawShortfall" BIGINT;
