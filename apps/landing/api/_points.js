/** The only place a point value lives. Placeholders the team will change. An
 *  award stores the value at write time, so a change applies to new awards. */
export const POINTS = { referral: 100, x_connect: 50, referred: 25 };

/** Placeholders until the team supplies the real list. `check`: `oauth` is
 *  granted by its own flow, `honor` by the claim route. Honor and later checks
 *  need X connected. The ledger stores `points` at write time. */
export const QUESTS = [
  { id: "x_connect", title: "Connect X", url: "/", points: POINTS.x_connect, check: "oauth" },
  { id: "x_follow", title: "Follow @hexo", url: "https://x.com/hexo", points: 25, check: "honor" },
  { id: "x_retweet", title: "Retweet the launch post", url: "https://x.com/hexo", points: 25, check: "honor" },
];
