export type Tab =
  | "HOME"
  | "MINE"
  | "VAULT"
  | "WEEKLY DRAW"
  | "LEADERBOARD"
  | "ABOUT";

/**
 * Navbar items: the desktop long label and the phone short label. Only EARN
 * and PLAY show for now; the other tabs stay routable (HOME via the logomark,
 * the rest via the URL hash below) but unlisted.
 */
export const TABS = [
  { id: "VAULT", long: "EARN", short: "EARN" },
  { id: "MINE", long: "PLAY", short: "PLAY" },
] as const satisfies readonly { id: Tab; long: string; short: string }[];

/** URL hash → tab, so `/#play` opens the hex page directly (e2e specs rely on it). */
const HASH_TABS: Record<string, Tab> = {
  home: "HOME",
  play: "MINE",
  earn: "VAULT",
  draw: "WEEKLY DRAW",
  ranks: "LEADERBOARD",
  about: "ABOUT",
};

export function tabFromHash(hash: string): Tab {
  return HASH_TABS[hash.replace(/^#/, "").toLowerCase()] ?? "HOME";
}
