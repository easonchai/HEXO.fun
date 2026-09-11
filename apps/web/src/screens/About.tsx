/**
 * ABOUT tab: the Figma "About Page" frame (340:17234). The marketing site's
 * pitch, inside the app: hero with the self-playing board, four stats, how
 * it works, the jackpot, what you can and can't lose, FAQ, closing line.
 * The Figma's hero and closing buttons were dropped: the tab bar already
 * routes to PLAY and EARN.
 *
 * Copy is the Figma's, except the draw cadence. Epochs are a day long
 * (`epochSeconds` 86_400), and `touch` sets `entries = principal` on every
 * rollover, so both the draw and the ticket reset are daily. The base yield
 * has no payout schedule in the program, so those two lines still say weekly.
 */
import { DemoBoard } from "../arena/DemoBoard.js";
import { LogoCog, LogoWordmark } from "../arena/Arena.js";
import { Textile } from "../arena/Textile.js";
import { GlyphRow } from "./Home.js";

const STATS = [
  ["5%", "APR base yield, paid out weekly"],
  ["1", "Jackpot draw, every day"],
  ["100%", "Of your principal, protected"],
  ["60s", "Mini games to boost your chances"],
] as const;

const HOW = [
  [
    "Deposit USDC",
    "Your money goes into the pool and stays yours. It starts earning straight away.",
  ],
  [
    "Earn 5%",
    "You earn 5% APR yield, paid out every week, whether you play or not.",
  ],
  [
    "Every dollar is a ticket",
    "$1 deposited is 1 ticket in the daily jackpot. The jackpot is funded by everyone's additional yield.",
  ],
  [
    "Sit tight, or play for more",
    "Do nothing and your tickets are already in today's draw. Or spend them in one-minute games to win more tickets and more chances. Either way your deposit never moves.",
  ],
] as const;

const RULES = [
  [
    "Where your deposit sits?",
    "Your USDC is lent out through established lending protocols. That lending is where the 5% comes from. It is never used to fund the jackpot, pay winners, or run games.",
  ],
  [
    "Withdrawals",
    "You can withdraw at any time by burning that day's tickets. Spent half your tickets? Half your deposit is still free to go. Spent them all? The rest is yours again at the next daily reset, when tickets refresh.",
  ],
  [
    "We play too",
    "We hold tickets in the daily draw like everyone else. If our ticket wins, the jackpot goes to the treasury and to buying back our token. It always goes back to the community.",
  ],
  [
    "House cut",
    "The House takes 6% of every round pot in tickets before the winners split the rest. Your deposit is never charged.",
  ],
] as const;

const FAQ = [
  [
    "Can I lose my deposit?",
    "No. Your deposit is never at stake. Only tickets are.",
  ],
  [
    "Do I have to play?",
    "No. Every dollar you deposit is already a ticket in the daily draw. Playing is how you win more tickets, not how you enter.",
  ],
  [
    "What if I lose a game round?",
    "You lose the tickets you put in. Your deposit and your 5% aren't touched, and your tickets refresh tomorrow.",
  ],
  [
    "Where does the jackpot come from?",
    "From the yield the pool earns above 5%. Nothing else.",
  ],
  [
    "Is the 5% guaranteed?",
    "It's the base yield the pool pays before any of it becomes the jackpot. It comes from lending your USDC out to earn yield, so if that yield ever dropped below 5%, the base would too. Your deposit still wouldn't be touched.",
  ],
  [
    "Can I withdraw anytime?",
    "Yes. Withdrawing burns that day's tickets, so you can take out whatever share of your tickets you still hold. Spend them all and the rest comes back to you at the daily reset.",
  ],
  [
    "Do you take any of the prize?",
    "A small protocol fee funds ongoing operations and token buybacks. The rest goes to that day's winner.",
  ],
] as const;

/** Numbered step: the Figma cycles a circle, star, square and plus badge. */
const BADGES = ["circle", "star", "square", "plus"] as const;

function Steps({ items }: { items: readonly (readonly [string, string])[] }) {
  return (
    <ol className="about-steps">
      {items.map(([title, body], i) => (
        <li key={title} className="about-step">
          <span className={`about-badge about-badge-${BADGES[i % 4]}`}>
            {String(i + 1).padStart(2, "0")}
          </span>
          <div>
            <h3 className="about-step-title">{title}</h3>
            <p className="about-step-body">{body}</p>
          </div>
        </li>
      ))}
    </ol>
  );
}

function Label({ children }: { children: string }) {
  return (
    <span className="about-label">
      <Textile sym={1} size={20} />
      {children}
    </span>
  );
}

/**
 * The footer's textile pattern, Figma's TextilePixelBg: 39px symbols on a
 * 47px grid, the six symbols cycling along each row and the cycle shifted
 * one place per row so they read as diagonal stripes. One 6x6 tile repeats.
 */
const TEXTILE_PITCH = 47;
const TEXTILE_CELLS = [0, 1, 2, 3, 4, 5];

function TextileBg() {
  const tile = TEXTILE_PITCH * TEXTILE_CELLS.length;
  return (
    <svg className="about-textile" aria-hidden="true">
      <defs>
        <pattern
          id="about-textile"
          width={tile}
          height={tile}
          patternUnits="userSpaceOnUse"
        >
          {TEXTILE_CELLS.flatMap((row) =>
            TEXTILE_CELLS.map((col) => (
              <g
                key={`${row}-${col}`}
                transform={`translate(${col * TEXTILE_PITCH} ${row * TEXTILE_PITCH})`}
                color="currentColor"
              >
                <Textile sym={(col + row) % 6} size={39} />
              </g>
            )),
          )}
        </pattern>
      </defs>
      <rect width="100%" height="100%" fill="url(#about-textile)" />
    </svg>
  );
}

export function About() {
  return (
    <div className="about" data-testid="about-screen">
      <section className="about-hero">
        <div className="about-hero-copy">
          <span className="about-lockup">
            <LogoCog size={35} />
            <LogoWordmark height={15} />
          </span>
          <h1 className="about-h1">
            save your money, <em>play your luck</em>
          </h1>
          <p className="about-sub">A no-loss savings app.</p>
          <p className="about-lead">
            Deposit USDC, never lose it, win a daily prize.
          </p>
        </div>
        <DemoBoard className="about-board" />
      </section>

      <section className="about-section about-why">
        <img className="about-art about-art-tokens" src="/about/tokens.webp" alt="" />
        <GlyphRow />
        <h2 className="about-h2 about-center">
          WHY <em>HEXO?</em>
        </h2>
        <div className="about-stats">
          {STATS.map(([value, label]) => (
            <div key={value} className="about-stat">
              <strong>{value}</strong>
              <span>{label}</span>
            </div>
          ))}
        </div>
        <GlyphRow />
      </section>

      <section className="about-section" id="about-how">
        <img className="about-art about-art-bank" src="/about/bank.webp" alt="" />
        <Label>How it works</Label>
        <h2 className="about-h2">
          All it takes is just
          <br />
          <em>one deposit.</em>
        </h2>
        <Steps items={HOW} />
      </section>

      <section className="about-section about-jackpot">
        <img className="about-art about-art-ticket" src="/about/ticket.webp" alt="" />
        <GlyphRow />
        <h2 className="about-h2 about-center">
          Every day,
          <br />
          <em>1 jackpot.</em>
        </h2>
        <p className="about-jackpot-body">
          The winner takes the jackpot. Everyone else keeps their deposit and
          their 5%. Nobody goes home with less than they arrived with.
        </p>
        <GlyphRow />
      </section>

      <section className="about-section">
        <img className="about-art about-art-shield" src="/about/shield.webp" alt="" />
        <Label>How it works</Label>
        <h2 className="about-h2">
          What you <em>can</em> &amp; <em>can't lose.</em>
        </h2>
        <div className="about-lose">
          <div className="about-lose-card about-lose-safe">
            <h3>You Won't Lose</h3>
            <ul>
              <li>Your USDC deposit</li>
              <li>Your 5% base yield</li>
              <li>Your right to withdraw</li>
            </ul>
          </div>
          <div className="about-lose-card about-lose-risk">
            <h3>You Might Lose</h3>
            <ul>
              <li>Tickets you wager in a game round which is used in the daily draw</li>
            </ul>
          </div>
        </div>
        <Steps items={RULES} />
      </section>

      <section className="about-section" id="about-faq">
        <Label>FAQ</Label>
        <h2 className="about-h2">
          The Short <em>Answers</em>
        </h2>
        <div className="about-faq" data-testid="about-faq">
          {FAQ.map(([q, a]) => (
            <details key={q} className="about-faq-item">
              <summary>{q}</summary>
              <p>{a}</p>
            </details>
          ))}
        </div>
      </section>

      <section className="about-section about-close">
        <TextileBg />
        <GlyphRow />
        <h2 className="about-h2 about-center about-close-title">
          Start Saving, <em>Maybe Win</em>
        </h2>
        <GlyphRow />
      </section>
    </div>
  );
}
