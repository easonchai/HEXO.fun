-- beta-launch-fixes ticket 17: the invite gate's one-time terms/risk/privacy
-- acknowledgement, stored with the redemption it gates. Additive and
-- nullable so existing rows (redeemed before this column existed) stay
-- valid; every new redeem sets it.

-- AlterTable
ALTER TABLE "InviteRedemption" ADD COLUMN "termsAcknowledgedAt" BIGINT;
