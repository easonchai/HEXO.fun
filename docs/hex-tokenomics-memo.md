# Decision memo: should the HEX token exist?

**Decision: No. HEX must not exist now, and the default going forward is "does not exist"
unless a future memo affirmatively reverses this with the evidence below.**

This memo covers whether HEX should exist at all — per the directive, no code accompanies
it. Today's date: 2026-09-03.

## 1. The test HEX must pass

A token is justified only if it creates demand that is (a) real, (b) non-coercive, and
(c) legally survivable — without touching principal, distorting game fairness, or promising
returns. HEX currently fails all three:

- **No real demand driver.** The only proposed sinks (buyback funded by the 6% fee) require
  Lane B fee revenue that does not exist (see `docs/launch-decision.md`). A buyback budget
  of zero cannot support a market.
- **Demand would be coerced from savings.** Any utility that lifts prize odds or entry
  access converts the savings product into a pay-to-win lottery — a fairness and
  consumer-protection failure the PRD explicitly forbids (§10, §14.11).
- **Legal classification unresolved.** A token whose value story is "protocol revenue buys
  and burns it" is adjacent to a security/emissions claim in most jurisdictions. No
  jurisdictional analysis exists.

## 2. Specific whiteboard ideas — verdicts

| Idea                                              | Verdict                                              | Reason                                                                                                                                                                                                                             |
| ------------------------------------------------- | ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 6% fee → 50% HEX buyback                          | **Reject for v1**                                    | No fee base; Lane B not approved. Revisit only post-Lane-B with an economic review.                                                                                                                                                |
| 95% burn / 5% staking of acquired HEX             | **Reject now**                                       | Burn of a protocol asset with a staking pool is a return narrative; needs securities analysis first.                                                                                                                               |
| 3,000,000 cap / 10,000 initial / 5-year emissions | **Reject**                                           | Numbers without a model. No distribution, vesting, or concentration analysis exists.                                                                                                                                               |
| Sell tax                                          | **Reject permanently-leaning**                       | A transfer tax on holders to support a buyback story is the classic red flag in every regulatory framework we would operate under.                                                                                                 |
| Cosmetic themes / profile utility                 | **Neutral — the only surviving idea**                | Non-financial, non-probability-affecting. Viable later as plain premium content, sold for the pool asset; does not require a token at all. If a token simplifies payment, revisit as a feature decision, not a tokenomics program. |
| Revenue-sharing staking                           | **Reject until revenue exists and counsel approves** | Requires real, recurring, legally shareable protocol revenue plusKYC-capable distribution.                                                                                                                                         |
| Harvest/auto-automation fees                      | **Out of scope**                                     | Already excluded by tokenomics §9; a fee wrapper on automation is not a token thesis.                                                                                                                                              |

## 3. What would have to be true to revisit (all, not some)

1. Lane B (transferable-reward game) launched and generating audited, sustained non-principal
   revenue — the only legitimate funding source for buybacks or rewards.
2. A dedicated tokenomics PRD with: exact supply/emission formulae, allocation and vesting,
   custody of treasury, market-execution limits (venues, caps, slippage, delay), MEV and
   concentration analysis, staking eligibility, tax treatment, and failure modes.
3. Written legal opinion on classification in every target jurisdiction, covering buyback+
   burn, staking distribution, and transfer restrictions.
4. Independent economic review (adverse selection, sustainability, death-spiral scenarios).
5. Governance approval through the multisig/timelock process with public change record.

## 4. Consequences for the codebase (enforced, not aspirational)

- No HEX mint, treasury, buyback, or staking accounts exist in the program, and none may be
  added without the gates above.
- No fee path exists in v1 (`docs/launch-decision.md`), so no revenue stream could silently
  accumulate toward a token launch.
- The buyback-escrow rows in tokenomics §5 are recorded as **future design**, not roadmap.

**Bottom line:** HEX today would be a liability attached to a product that does not need it.
Ship the savings game. Revisit the token only when real, legal, non-principal revenue
exists and survives an economic and legal review.
