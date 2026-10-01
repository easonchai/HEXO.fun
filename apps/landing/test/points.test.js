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
// Tagged-template client shaped like neon's: resolves to the row array.
const client = (strings, ...vals) =>
  pool.query(strings.reduce((q, s, i) => `${q}$${i}${s}`), vals).then((r) => r.rows);

test.before(async () => {
  if (skip) return;
  const { Pool } = pg.default;
  const admin = new Pool({ connectionString: url });
  await admin.query(`create schema ${schema}`);
  await admin.end();
  pool = new Pool({ connectionString: url, options: `-c search_path=${schema}` });
  useSql(client);
  await ensureSchema();
});

test.after(async () => {
  if (skip) return;
  await pool.query(`drop schema ${schema} cascade`);
  await pool.end();
});

let n = 0;
async function member({ code, referredBy = null, createdAt = new Date(), x = false }) {
  const email = `u${n++}@example.com`;
  const rows = await pool.query(
    `insert into waitlist (email, code, referred_by, created_at, x_user_id)
     values ($1, $2, $3, $4, $5) returning id`,
    [email, code, referredBy, createdAt, x ? `x${n}` : null],
  );
  return rows.rows[0].id;
}
const awards = async () =>
  (await pool.query("select waitlist_id, kind, ref, points from waitlist_points")).rows;

test("no referral award until the invitee connects X", { skip }, async () => {
  const before = (await awards()).length;
  await member({ code: "ee0001" });
  const fresh = await member({ code: "ee0002", referredBy: "ee0001" });
  await awardReferrals(fresh);
  assert.equal((await awards()).length, before);
});

test("X connect writes both rows once", { skip }, async () => {
  const referrer = await member({ code: "aa0001" });
  const fresh = await member({ code: "aa0002", referredBy: "aa0001", x: true });
  await awardReferrals(fresh);
  await awardReferrals(fresh);
  const mine = (await awards()).filter((a) => [referrer, fresh].includes(a.waitlist_id));
  assert.deepEqual(mine, [
    { waitlist_id: referrer, kind: "referral", ref: fresh, points: POINTS.referral },
    { waitlist_id: fresh, kind: "referred", ref: "", points: POINTS.referred },
  ]);
  const body = await loadMember(referrer);
  assert.equal(body.points, POINTS.referral);
  assert.equal(body.referrals, 1);
});

test("self-referral earns nothing", { skip }, async () => {
  const before = (await awards()).length;
  const me = await member({ code: "ff0001", referredBy: "ff0001", x: true });
  await awardReferrals(me);
  assert.equal((await awards()).length, before);
});

test("an unknown referrer code writes nothing", { skip }, async () => {
  const before = (await awards()).length;
  const fresh = await member({ code: "bb0001", referredBy: "nobody" });
  await awardReferrals(fresh);
  assert.equal((await awards()).length, before);
});

test("the backfill credits old referrals once", { skip }, async () => {
  const referrer = await member({ code: "cc0001" });
  await member({ code: "cc0002", referredBy: "cc0001", x: true });
  await member({ code: "cc0003", referredBy: "cc0001", x: true });
  await awardReferrals();
  const first = (await awards()).filter((a) => a.waitlist_id === referrer);
  assert.equal(first.length, 2);
  await awardReferrals();
  await ensureSchema();
  assert.equal((await awards()).filter((a) => a.waitlist_id === referrer).length, 2);
  assert.equal((await loadMember(referrer)).referrals, 2);
});

test("the backfill deletes referral rows for invitees without X", { skip }, async () => {
  const referrer = await member({ code: "gg0001" });
  const bare = await member({ code: "gg0002", referredBy: "gg0001" });
  const withX = await member({ code: "gg0003", referredBy: "gg0001", x: true });
  const row = (ref) =>
    pool.query(
      "insert into waitlist_points (waitlist_id, kind, ref, points) values ($1, 'referral', $2, 100)",
      [referrer, ref],
    );
  await row(bare);
  await row(withX);
  useSql(client); // resets the cached schema check so ensureSchema reruns
  await ensureSchema();
  const refs = (await awards()).filter((a) => a.waitlist_id === referrer).map((a) => a.ref);
  assert.deepEqual(refs, [withX]);
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
  await member({ code: "dd0003", referredBy: "dd0002", createdAt: day(3), x: true });
  await awardReferrals();
  assert.ok((await loadMember(later)).rank < (await loadMember(earlier)).rank);
});
