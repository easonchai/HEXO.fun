/** ABOUT tab — what this is, honestly, with the operational boundary stated. */
import { LogoCog } from "../arena/Arena.js";
import { HeadRow, PanelCard, Stat, StatGrid } from "../ui.js";
import { PROGRAM_ID } from "../chain.js";

export function About({ symbol }: { symbol: string }) {
  const program = PROGRAM_ID.toBase58();
  return (
    <div className="screen-vault" data-testid="about-screen">
      <PanelCard wide title="WHAT THIS IS" aside={<LogoCog size={22} />}>
        <p className="screen-copy">
          HexVault is a no-loss lottery prototype. You deposit {symbol} and the
          pool credits you equal Principal and Entries. Principal is yours 1:1
          against the deposit and is never at risk. Entries are lottery weight:
          they decide your odds in the epoch draw, and you can risk them on the
          board against other depositors. The jackpot is the yield the pool
          earned during the epoch, simulated here at a published rate and
          labelled as such.
        </p>
        <HeadRow title="WHAT CAN GO WRONG" />
        <p className="screen-copy">
          Your balance is denominated in the accepted asset, so its issuer, peg
          and liquidity risk flow straight through to you. Entries staked on the
          board can be lost to other players: a round pays only the positions
          covering the winning tile, pro rata, and a round nobody covered goes
          to the House. Losing Entries lowers what you can withdraw until the
          next epoch resets Entries to Principal. The pool has an authority key
          and depends on an off-chain operator and the ORAO VRF oracle, and this
          build runs on a local validator or devnet with test assets only.
        </p>
        <StatGrid>
          <Stat label="Accepted asset" value={symbol} />
          <Stat
            label="Program"
            value={`${program.slice(0, 5)}…${program.slice(-5)}`}
            small
          />
          <Stat label="Status" value="DEVNET / LOCALNET ONLY" />
        </StatGrid>
      </PanelCard>

      <PanelCard wide title="OPERATOR LOOP">
        <p className="screen-copy">
          The lifecycle steps belong to the operator, not to players: it opens
          epochs and rounds, requests randomness, settles rounds, cranks
          registration, funds the simulated yield and pays the epoch winner.
          The jackpot is transferred straight to the winner's token account,
          with no step for the winner to take.
        </p>
        <p className="screen-copy">
          Two instructions are permissionless and this app sends them for you
          when they are useful: settling your own position after a round
          reveals, and registering your Weight in an epoch that has ended.
          Everything else here is a deposit, a withdrawal or a position.
        </p>
      </PanelCard>
    </div>
  );
}
