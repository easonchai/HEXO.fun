# The jackpot is pushed to the winner; there is no claim instruction

> **Superseded by compounding prize (hexo-referrals ticket 02).** A non-House winner's prize no
> longer pays their own token account; `payout` moves it into the principal vault and compounds
> it into their Principal and Tickets, withdrawn later through the normal locked flow. The push
> (no claim step, no signer) and the House's 50% buyback / 20% treasury / 30% rollover split are
> unchanged. See [`docs/architecture.md`](../architecture.md#fund-flow)'s fund-flow diagram.

With registration on chain (ADR-0002) the program knows the winner's pubkey, so the operator calls `payout` and the USDC lands in the winner's wallet. The first build's claim, claim deadline, expiry, and unclaimed-prize policy are deleted. Consequence: the winner's associated token account is created by the operator inside the payout transaction if missing, and the operator pays that rent. A winner who never returns still gets paid.
