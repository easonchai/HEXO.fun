/** ABOUT tab — what this is, honestly, with the operational boundary stated. */
import { LogoCog } from "../arena/Arena.js";

export function About({
  symbol,
  cluster,
}: {
  symbol: string;
  cluster: string;
}) {
  return (
    <div className="screen-vault" data-testid="about-screen">
      <div className="panel-card wide">
        <div className="panel-head">
          <span className="panel-title">WHAT THIS IS</span>
          <LogoCog size={22} />
        </div>
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
        <div className="panel-head">
          <span className="panel-title">WHAT CAN GO WRONG</span>
        </div>
        <p className="screen-copy">
          Your balance is denominated in the accepted asset, so its issuer, peg,
          and liquidity risk flow straight through to you. Spending ET on boards
          is a loss of that spend with no guarantee of return — rounds pay only
          the positions covering the winning tile, pro rata. The protocol has
          administrative roles (authority, guardian, snapshot authority) and a
          randomness provider, and this build runs on Solana devnet or a local
          validator with test assets only. Do not treat it as a savings product.
        </p>
        <p className="screen-copy">
          Each round, one of 36 tiles wins. The draw uses the program's
          randomness boundary; covering positions earn a proportional ET bonus.
          Each epoch, the snapshot authority commits a Merkle-sum root of all
          entry weights, and the prize and Hexpot jackpots are drawn against it.
          Winners prove their claim with a Merkle proof — built right here in
          your browser.
        </p>
        <div className="stat-grid">
          <div className="stat">
            <span className="stat-label">Cluster</span>
            <span className="stat-value">{cluster}</span>
          </div>
          <div className="stat">
            <span className="stat-label">Program</span>
            <span className="stat-value small">6aDFS…TSGvB</span>
          </div>
          <div className="stat">
            <span className="stat-label">Status</span>
            <span className="stat-value">DEVNET / LOCALNET ONLY</span>
          </div>
        </div>
      </div>

      <div className="panel-card wide">
        <div className="panel-head">
          <span className="panel-title">OPERATOR LOOP</span>
        </div>
        <p className="screen-copy">
          Some lifecycle steps belong to the operator, not players: creating
          pools, epochs and rounds, committing the prize snapshot and jackpot,
          funding the prize/jackpot escrows, and fulfilling randomness with the
          mock authority. The ops CLI ( <code>packages/cli</code>) drives them:
        </p>
        <pre className="about-code">{`hexvault pool create …
hexvault epoch create --pool-id 1 …
hexvault round create --pool-id 1 …
hexvault snapshot commit --pool-id 1 --epoch-id 1 …
hexvault jackpot commit --pool-id 1 --epoch-id 1
hexvault fulfill --pool-id 1 --round-id 1 --sample 123…`}</pre>
        <p className="screen-copy">
          Anything a player can do permissionlessly (close a round's draw,
          request epoch draws, claim any win) is available in this app.
        </p>
      </div>
    </div>
  );
}
