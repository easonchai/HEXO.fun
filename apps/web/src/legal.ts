/**
 * beta-launch-fixes ticket 17: terms, risk disclosure and privacy notice
 * links, shared by the invite gate, the wallet menu and the About footer.
 * Static pages under public/ (not React routes) so they still work while
 * the invite gate blocks the rest of the app. Placeholder text ships with a
 * visible "draft" banner until the human supplies the final copy — see each
 * page's own comment.
 */
export const TERMS_URL = "/terms.html";
export const RISK_URL = "/risk.html";
export const PRIVACY_URL = "/privacy.html";
