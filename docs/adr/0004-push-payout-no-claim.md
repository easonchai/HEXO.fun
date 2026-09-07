# The jackpot is pushed to the winner; there is no claim instruction

With registration on chain (ADR-0002) the program knows the winner's pubkey, so the operator calls `payout` and the USDC lands in the winner's wallet. The first build's claim, claim deadline, expiry, and unclaimed-prize policy are deleted. Consequence: the winner's associated token account is created by the operator inside the payout transaction if missing, and the operator pays that rent. A winner who never returns still gets paid.
