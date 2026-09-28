-- Splits the Referral code out of the Invite code (ADR 0014,
-- docs/plan/referral-page ticket 01). Every existing depositor-owned Invite
-- code ("ownerWallet" not null) becomes a ReferralCode under the same code
-- string; admin codes ("ownerWallet" null) are untouched and stay Invite
-- codes. InviteRedemption.code and Referral.code hold no foreign key to
-- InviteCode (see 20260921100040 and 20260921140000's own comments), so
-- deleting the moved rows leaves every redemption and Referral already bound
-- through them intact.
--
-- DISTINCT ON guards against the one wallet that owns more than one Invite
-- code (`admin create-invite --owner X --count 2+`), which ReferralCode's
-- unique owner would otherwise reject outright: it keeps that wallet's
-- earliest owned code as their Referral code and drops the rest, same as
-- every other owned code this migration removes.

-- CreateTable
CREATE TABLE "ReferralCode" (
    "code" TEXT NOT NULL,
    "owner" TEXT NOT NULL,
    "createdAt" BIGINT NOT NULL,

    CONSTRAINT "ReferralCode_pkey" PRIMARY KEY ("code")
);

-- CreateIndex
CREATE UNIQUE INDEX "ReferralCode_owner_key" ON "ReferralCode"("owner");

-- Move each depositor-owned Invite code into it.
INSERT INTO "ReferralCode" ("code", "owner", "createdAt")
SELECT DISTINCT ON ("ownerWallet") "code", "ownerWallet", "createdAt"
FROM "InviteCode"
WHERE "ownerWallet" IS NOT NULL
ORDER BY "ownerWallet", "createdAt" ASC;

DELETE FROM "InviteCode" WHERE "ownerWallet" IS NOT NULL;
