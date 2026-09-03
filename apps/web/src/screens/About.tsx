/** ABOUT tab — what this is, honestly, with the operational boundary stated. */
import { LogoCog } from "../arena/Arena.js";
import { HeadRow, PanelCard, Stat, StatGrid } from "../ui.js";

export function About({
  symbol,
  cluster,
}: {
  symbol: string;
  cluster: string;
}) {
  return (
    <div className="screen-vault" data-testid="about-screen">
      <PanelCard wide title="WHAT THIS IS" aside={<LogoCog size={22} />}>
        <p className="screen-copy">
          HexVault is a prize-linked savings prototype. You deposit {symbol} and
          receive matched PT + ET receipts (non-transferable, Token-2022). ET
          pays for board positions; PT stays matched to your principal. On
          withdrawal the two burn together 1:1, so what you can withdraw equals
          your deposited {symbol} minus the {symbol} value of ET you have
          already spent on boards. Nothing here is yield, interest, insurance,
          or a guarantee — the principal vault simply holds your deposit until
          you withdraw it.
        </p>
        <HeadRow title="WHAT CAN GO WRONG" />
        <p className="screen-copy">
          Your balance is denominated in the accepted asset, so its issuer, peg,
          and liquidity risk flow straight through to you. Spending ET on boards
          is a spend with no guarantee of return — rounds pay only positions
          covering the winning tile, pro rata. The protocol has administrative
          roles (authority, guardian, snapshot authority) and a VRF oracle
          network, and this build runs on Solana devnet or a local validator
          with test assets only. Do not treat it as a savings product.
        </p>
        <StatGrid>
          <Stat label="Cluster" value={cluster} />
          <Stat label="Program" value="6aDFS…TSGvB" small />
          <Stat label="Status" value="DEVNET / LOCALNET ONLY" />
        </StatGrid>
      </PanelCard>

      <PanelCard wide title="OPERATOR LOOP">
        <p className="screen-copy">
          Some lifecycle steps belong to the operator, not players: creating
          pools, epochs and rounds, committing the prize snapshot and jackpot,
          funding the prize/jackpot escrows, and settling draws (VRF on devnet,
          mock authority on localnet). The ops CLI ( <code>packages/cli</code>)
          drives them:
        </p>
        <pre className="about-code">{`hexvault pool create …
hexvault epoch create --pool-id 1 …
hexvault round create --pool-id 1 …
hexvault snapshot commit --pool-id 1 --epoch-id 1 …
hexvault jackpot commit --pool-id 1 --epoch-id 1
hexvault randomness request round --pool-id 1 --round-id 1 …
hexvault randomness fulfill-vrf round --pool-id 1 --round-id 1`}</pre>
        <p className="screen-copy">
          Anything a player can do permissionlessly (request a round's draw,
          request epoch draws, settle from the VRF, claim any win) is available
          in this app.
        </p>
      </PanelCard>
    </div>
  );
}
