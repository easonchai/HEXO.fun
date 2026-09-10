export type Tab =
  | "HOME"
  | "MINE"
  | "DASHBOARD"
  | "VAULT"
  | "DAILY DRAW"
  | "LEADERBOARD"
  | "ABOUT";

/**
 * Navbar items: the desktop long label and the phone short label. Only EARN,
 * PLAY and ABOUT show; the other tabs stay routable (HOME via the logomark,
 * the rest via the URL hash below) but unlisted.
 *
 * EARN lands on the DASHBOARD, not the deposit widget: the widget is one hop
 * further in, behind the dashboard's own Deposit / Withdraw buttons, so there
 * is a single way into the money path.
 */
export const TABS = [
  { id: "DASHBOARD", long: "EARN", short: "EARN" },
  { id: "MINE", long: "PLAY", short: "PLAY" },
  { id: "ABOUT", long: "ABOUT", short: "ABOUT" },
] as const satisfies readonly { id: Tab; long: string; short: string }[];

/** URL hash → tab, so `/#play` opens the hex page directly (e2e specs rely on it). */
const HASH_TABS: Record<string, Tab> = {
  home: "HOME",
  play: "MINE",
  earn: "DASHBOARD",
  deposit: "VAULT",
  draw: "DAILY DRAW",
  ranks: "LEADERBOARD",
  about: "ABOUT",
};

export function tabFromHash(hash: string): Tab {
  return HASH_TABS[hash.replace(/^#/, "").toLowerCase()] ?? "HOME";
}
