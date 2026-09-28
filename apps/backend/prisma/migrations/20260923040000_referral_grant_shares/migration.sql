-- Adds ReferralGrantShare (referral-page ticket 05, spec.md "Referral grant
-- shares"): one row per (epoch, referrer, referee) holding that referee's
-- share of the referrer's ReferralGrant.amount for that epoch. A new table,
-- so this is a plain CreateTable like ReferralGrant's own migration, not the
-- add-column-with-default-then-drop shape tables with existing rows use.

-- CreateTable
CREATE TABLE "ReferralGrantShare" (
    "epochId" BIGINT NOT NULL,
    "referrer" TEXT NOT NULL,
    "referee" TEXT NOT NULL,
    "amount" BIGINT NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "ReferralGrantShare_epochId_referrer_referee_key" ON "ReferralGrantShare"("epochId", "referrer", "referee");
