-- The container's start command is `prisma migrate deploy && node dist/main.js`,
-- and the row for the abandoned pool is still in the table there, so the three
-- columns land with a default and drop it again. 0 for one indexer tick; the
-- next `syncAccounts` upserts the real values off chain.

-- AlterTable
ALTER TABLE "Pool" ADD COLUMN     "currentEpochEndsAt" BIGINT NOT NULL DEFAULT 0,
ADD COLUMN     "epochAnchor" BIGINT NOT NULL DEFAULT 0,
ADD COLUMN     "previousEpochEndsAt" BIGINT NOT NULL DEFAULT 0;

ALTER TABLE "Pool" ALTER COLUMN "currentEpochEndsAt" DROP DEFAULT,
ALTER COLUMN "epochAnchor" DROP DEFAULT,
ALTER COLUMN "previousEpochEndsAt" DROP DEFAULT;
