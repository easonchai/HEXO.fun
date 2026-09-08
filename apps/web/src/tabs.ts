export type Tab =
  | "HOME"
  | "MINE"
  | "DASHBOARD"
  | "VAULT"
  | "WEEKLY DRAW"
  | "LEADERBOARD"
  | "ABOUT";

/**
 * Navbar items: the desktop long label and the phone short label. Only EARN
 * and PLAY show for now; the other tabs stay routable (HOME via the logomark,
 * the rest via the URL hash below) but unlisted.
 *
 * EARN lands on the DASHBOARD, not the deposit widget: the widget is one hop
 * further in, behind the dashboard's own Deposit / Withdraw buttons, so there
 * is a single way into the money path.
 */
export const TABS = [
  { id: "DASHBOARD", long: "EARN", short: "EARN" },
  { id: "MINE", long: "PLAY", short: "PLAY" },
] as const satisfies readonly { id: Tab; long: string; short: string }[];

/** URL hash → tab, so `/#play` opens the hex page directly (e2e specs rely on it). */
const HASH_TABS: Record<string, Tab> = {
  home: "HOME",
  play: "MINE",
  earn: "DASHBOARD",
  deposit: "VAULT",
  draw: "WEEKLY DRAW",
  ranks: "LEADERBOARD",
  about: "ABOUT",
};

export function tabFromHash(hash: string): Tab {
  return HASH_TABS[hash.replace(/^#/, "").toLowerCase()] ?? "HOME";
}
