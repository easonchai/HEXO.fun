import test from "node:test";
import assert from "node:assert/strict";
import { awardReferrals, ensureSchema, loadMember, useSql } from "../api/_lib.js";
import { POINTS } from "../api/_points.js";

// Needs a real Postgres: TEST_DATABASE_URL=postgres://... npm test
// It uses `pg`, which the workspace hoists but landing does not declare, and a
// throwaway schema so the database's own tables are never touched. Without
// either, the tests are skipped.
const url = process.env.TEST_DATABASE_URL;
const pg = url ? await import("pg").catch(() => null) : null;
const skip = !pg && "set TEST_DATABASE_URL (and have pg installed) to run";

const schema = `landing_test_${process.pid}`;
let pool;

test.before(async () => {
  if (skip) return;
  const { Pool } = pg.default;
  const admin = new Pool({ connectionString: url });
  await admin.query(`create schema ${schema}`);
  await admin.end();
  pool = new Pool({ connectionString: url, options: `-c search_path=${schema}` });
  // Tagged-template client shaped like neon's: resolves to the row array.
  useSql((strings, ...vals) =>
    pool.query(strings.reduce((q, s, i) => `${q}$${i}${s}`), vals).then((r) => r.rows),
  );
  await ensureSchema();
});

test.after(async () => {
  if (skip) return;
  await pool.query(`drop schema ${schema} cascade`);
  await pool.end();
});

let n = 0;
async function member({ code, referredBy = null, createdAt = new Date() }) {
  const email = `u${n++}@example.com`;
  const rows = await pool.query(
    `insert into waitlist (email, code, referred_by, created_at)
     values ($1, $2, $3, $4) returning id`,
    [email, code, referredBy, createdAt],
  );
  return rows.rows[0].id;
}
const awards = async () =>
  (await pool.query("select waitlist_id, kind, ref, points from waitlist_points")).rows;

test("a repeated sign-in writes one referral award", { skip }, async () => {
  const referrer = await member({ code: "aa0001" });
  const fresh = await member({ code: "aa0002", referredBy: "aa0001" });
  await awardReferrals(fresh);
  await awardReferrals(fresh);
  const mine = (await awards()).filter((a) => a.waitlist_id === referrer);
  assert.deepEqual(mine, [
    { waitlist_id: referrer, kind: "referral", ref: fresh, points: POINTS.referral },
  ]);
  const body = await loadMember(referrer);
  assert.equal(body.points, POINTS.referral);
  assert.equal(body.referrals, 1);
});

test("an unknown referrer code writes nothing", { skip }, async () => {
  const before = (await awards()).length;
  const fresh = await member({ code: "bb0001", referredBy: "nobody" });
  await awardReferrals(fresh);
  assert.equal((await awards()).length, before);
});

test("the backfill credits old referrals once", { skip }, async () => {
  const referrer = await member({ code: "cc0001" });
  await member({ code: "cc0002", referredBy: "cc0001" });
  await member({ code: "cc0003", referredBy: "cc0001" });
  await awardReferrals();
  const first = (await awards()).filter((a) => a.waitlist_id === referrer);
  assert.equal(first.length, 2);
  await awardReferrals();
  await ensureSchema();
  assert.equal((await awards()).filter((a) => a.waitlist_id === referrer).length, 2);
  assert.equal((await loadMember(referrer)).referrals, 2);
});

test("equal points rank the earlier signup first", { skip }, async () => {
  const day = (d) => new Date(Date.UTC(2020, 0, d));
  const later = await member({ code: "dd0002", createdAt: day(2) });
  const earlier = await member({ code: "dd0001", createdAt: day(1) });
  const a = await loadMember(earlier);
  const b = await loadMember(later);
  assert.equal(a.points, b.points);
  assert.ok(a.rank < b.rank);
  // A referral award moves the later signup ahead.
  await member({ code: "dd0003", referredBy: "dd0002", createdAt: day(3) });
  await awardReferrals();
  assert.ok((await loadMember(later)).rank < (await loadMember(earlier)).rank);
});
