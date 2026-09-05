// Placeholder for the spec §3.6 bootstrap command (mint creation, ATAs,
// treasury/buyback accounts, create_pool). Ticket 05 is scaffold-only ("no
// business logic yet"); a later ticket fills this in. Deliberately a plain
// script, not a Nest application context — it must run before HEXUSDC_MINT
// exists, and that env var is required by ConfigModule's validation.
console.log(
  "bootstrap not implemented yet — see docs/plan/rebuild/spec.md §3.6",
);
