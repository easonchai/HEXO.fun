// Privy for a page without React. Bundled by build.js into /privy.js, which
// the page imports lazily: `const { login, logout } = await import("/privy.js")`.
// The app id is the apps/web one, inlined at build time from PRIVY_APP_ID.
import { createRoot } from "react-dom/client";
import { getIdentityToken, PrivyProvider, useLogin, usePrivy } from "@privy-io/react-auth";

let ready;
const privy = new Promise((resolve) => (ready = resolve));
// The latest render's Privy state, read at call time rather than captured.
const live = {};
// [resolve, reject] for the login in flight.
let pending = null;

async function token() {
  const t = await getIdentityToken();
  // Null means identity tokens are off in the Privy dashboard.
  if (!t) throw new Error("Privy returned no identity token");
  return t;
}

function Bridge() {
  const { ready: privyReady, authenticated, logout } = usePrivy();
  const { login } = useLogin({
    onComplete: () => token().then(pending?.[0], pending?.[1]).finally(() => (pending = null)),
    onError: (code) => {
      pending?.[1](Object.assign(new Error(`Privy login: ${code}`), { code }));
      pending = null;
    },
  });
  Object.assign(live, { authenticated, login, logout });
  if (privyReady) ready();
  return null;
}

const el = document.createElement("div");
document.body.appendChild(el);
createRoot(el).render(
  <PrivyProvider
    appId={PRIVY_APP_ID}
    config={{
      loginMethods: ["email"],
      appearance: { theme: "#0E1B2B", accentColor: "#B6FF3B", walletChainType: "solana-only" },
      embeddedWallets: {
        showWalletUIs: false,
        solana: { createOnLogin: "users-without-wallets" },
      },
    }}
  >
    <Bridge />
  </PrivyProvider>,
);

/** Resolves with a Privy identity token, opening the email modal if needed. */
export const login = () =>
  privy.then(() =>
    // A Privy session from an earlier visit skips the modal.
    live.authenticated
      ? token()
      : new Promise((resolve, reject) => {
          pending = [resolve, reject];
          live.login({ loginMethods: ["email"] });
        }),
  );

export const logout = () => privy.then(() => live.logout());
