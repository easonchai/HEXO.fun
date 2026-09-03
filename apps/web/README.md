# @hexvault/web

The designed HexVault UI ("HEXO" — Dark Navy & Electric Gold edition) driving
the program from the browser: hexagon arena with animated round settles,
deposit/board/claim flows, and a browser e2e harness (`scripts/e2e-web.sh`).
Dark theme is primary; light mode keeps the blue primary. All color flows
through the token blocks at the top of `src/styles.css`, and screens compose
the shared primitives in `src/ui.tsx`.

## Run

```sh
pnpm --filter @hexvault/web sync-idl   # after every `anchor build`
pnpm --filter @hexvault/web dev        # Vite dev server
```

Defaults (override with `.env` / `.env.local`): `VITE_CLUSTER=devnet`
(pass `localnet` for local development; `localnet` and `devnet` are the only
clusters the app boots against), `VITE_API_URL=http://localhost:8081`,
`VITE_PRIVY_APP_ID` (Privy is on by default via a publishable fallback id;
set `VITE_PRIVY_APP_ID=off` to use standard wallets only),
`VITE_BURNER_WALLET=1` (localnet dev burner).

## Scripts

| script                      | purpose                                                       |
| --------------------------- | ------------------------------------------------------------- |
| `dev` / `build` / `preview` | Vite                                                          |
| `check`                     | `tsc` over `src`                                              |
| `test`                      | Vitest unit tests (money, tiles, epoch labels, wallet policy) |
| `sync-idl`                  | copy `target/idl/hex_vault.json` -> `src/idl/hex_vault.json`  |

## Rules baked into the code

- Every balance is re-read from program/token accounts after each transaction;
  the indexer API is only a cache and its absence is shown as a banner.
- Amounts are bigint atomic units; formatting/parsing happens in
  `src/lib/money.ts` with no float in the path.
- The Board tab always shows entries burned, entries after, and withdrawable
  after before the submit button can be pressed.
- Transactions are built directly from the IDL (`src/actions.ts`), matching the
  frozen account layout in `programs/hex_vault`.
