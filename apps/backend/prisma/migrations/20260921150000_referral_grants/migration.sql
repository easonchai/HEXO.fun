-- Daily referral bonus grants (docs/plan/hexo-referrals ticket 08). A new
-- table, so this is a plain CreateTable like 20260921140000's Referral, not
-- the add-column-with-default-then-drop shape tables with existing rows use.
-- No primary key column: (epochId, referrer) is the natural key, enforced as
-- a unique index so createMany({ skipDuplicates: true }) can use it to make
-- writing a referrer's row for an epoch idempotent across restarts.

-- CreateTable
CREATE TABLE "ReferralGrant" (
    "epochId" BIGINT NOT NULL,
    "referrer" TEXT NOT NULL,
    "amount" BIGINT NOT NULL,
    "qualifiedCount" INTEGER NOT NULL,
    "rateBps" INTEGER NOT NULL,
    "txSig" TEXT
);

-- CreateIndex
CREATE UNIQUE INDEX "ReferralGrant_epochId_referrer_key" ON "ReferralGrant"("epochId", "referrer");
