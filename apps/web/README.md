# @hexvault/web (localnet skeleton)

Functional skeleton for driving the HexVault program from a browser. Plain
styling on purpose; the designed UI is a later phase.

## Run

```sh
pnpm --filter @hexvault/web sync-idl   # after every `anchor build`
pnpm --filter @hexvault/web dev        # Vite dev server
```

Defaults (override with `.env`): `VITE_CLUSTER=localnet`
(`http://127.0.0.1:8899`), `VITE_API_URL=http://localhost:8081`.
`localnet` and `devnet` are the only clusters the app will boot against.

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
