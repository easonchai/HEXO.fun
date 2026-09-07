# @hexvault/web

The designed HexVault UI ("HEXO" — Dark Navy & Electric Gold edition) driving
the program from the browser: hexagon arena with animated round settles, plus
the deposit and withdraw surface. Dark theme is primary; light mode keeps the
blue primary. All colour flows through the token blocks at the top of
`src/styles.css`, and screens compose the shared primitives in `src/ui.tsx`.

## Run

```sh
pnpm --filter @hexvault/web sync-idl   # after every `anchor build`
pnpm --filter @hexvault/web dev        # Vite dev server
```

Copy `.env.example` to `.env.local` and adjust. The five variables are
`VITE_RPC_URL`, `VITE_API_URL`, `VITE_PROGRAM_ID`, `VITE_POOL_ID` and
`VITE_PRIVY_APP_ID`; every one has a working default for a local validator.
`VITE_BURNER_WALLET=1` adds the dev burner wallet, and only when
`VITE_RPC_URL` points at localhost.

## Scripts

| script                      | purpose                                                      |
| --------------------------- | ------------------------------------------------------------ |
| `dev` / `build` / `preview` | Vite                                                         |
| `check`                     | `tsc` over `src`                                             |
| `test`                      | Vitest unit tests (money, tiles, round engine, feed rows)    |
| `sync-idl`                  | copy `target/idl/hex_vault.json` -> `src/idl/hex_vault.json` |

## Rules baked into the code

- `src/read.ts` owns the Pool, the connected wallet's Player and the open Round,
  re-read from chain every 2 s and immediately on a `RoundSettled` log. The API
  is a cache and its absence shows as a banner, never a crash.
- Amounts are bigint atomic units; formatting and parsing happen in
  `src/lib/money.ts` with no float in the path.
- Placing a position always shows Entries in, Entries after and withdrawable
  after before the button can be pressed.
- `withdrawable = min(Principal, Entries)`, the same rule the program enforces
  on `withdraw`.
- Transactions are built directly from the IDL (`src/actions.ts`). The Anchor
  client camelCases the IDL, so `buy_position` is reached as `buyPosition`.
