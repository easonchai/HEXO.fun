/** Tab list: single source for the desktop long label and the phone short label. */
export const TABS = [
  { id: "MINE", long: "MINE", short: "MINE" },
  { id: "VAULT", long: "VAULT", short: "VAULT" },
  { id: "WEEKLY DRAW", long: "WEEKLY DRAW", short: "DRAW" },
  { id: "LEADERBOARD", long: "LEADERBOARD", short: "RANKS" },
  { id: "ABOUT", long: "ABOUT", short: "ABOUT" },
] as const;

export type Tab = (typeof TABS)[number]["id"];
