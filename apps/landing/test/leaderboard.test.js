import test from "node:test";
import assert from "node:assert/strict";
import { ensureSchema, loadMemberByCode, useSql } from "../api/_lib.js";
import handler from "../api/leaderboard.js";

// Needs a real Postgres, same as points.test.js.
const url = process.env.TEST_DATABASE_URL;
const pg = url ? await import("pg").catch(() => null) : null;
const skip = !pg && "set TEST_DATABASE_URL (and have pg installed) to run";

const schema = `landing_test_lb_${process.pid}`;
let pool;

test.before(async () => {
  if (skip) return;
  process.env.DATABASE_URL ||= "unused";
  const { Pool } = pg.default;
  const admin = new Pool({ connectionString: url });
  await admin.query(`create schema ${schema}`);
  await admin.end();
  pool = new Pool({ connectionString: url, options: `-c search_path=${schema}` });
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
async function member({ code, handle = null, points = 0, createdAt = new Date() }) {
  const { rows } = await pool.query(
    `insert into waitlist (email, code, x_handle, created_at)
     values ($1, $2, $3, $4) returning id`,
    [`lb${n++}@example.com`, code, handle, createdAt],
  );
  if (points) {
    await pool.query(
      `insert into waitlist_points (waitlist_id, kind, ref, points) values ($1, 'test', '', $2)`,
      [rows[0].id, points],
    );
  }
}

async function call(method = "GET") {
  const res = {
    headers: {},
    setHeader(k, v) {
      this.headers[k] = v;
    },
    status(c) {
      this.code = c;
      return this;
    },
    json(b) {
      this.body = b;
      return this;
    },
  };
  await handler({ method }, res);
  return res;
}

test("name is the X handle, else the code, and no email leaks", { skip }, async () => {
  await member({ code: "bb0001", handle: "alice", points: 900 });
  await member({ code: "bb0002", points: 800 });
  const res = await call();
  assert.equal(res.code, 200);
  assert.equal(res.headers["Cache-Control"], "public, s-maxage=30");
  assert.deepEqual(res.body, [
    { rank: 1, name: "alice", points: 900 },
    { rank: 2, name: "bb0002", points: 800 },
  ]);
  assert.ok(!JSON.stringify(res.body).includes("@"));
});

test("rank matches loadMember through ties, and the board stops at 100", { skip }, async () => {
  const t = Date.now();
  for (let i = 0; i < 105; i++) {
    // Three point levels so ties fall back to signup time.
    await member({ code: `cc${String(i).padStart(4, "0")}`, points: 5 + (i % 3), createdAt: new Date(t - i) });
  }
  const { body } = await call();
  assert.equal(body.length, 100);
  for (const row of body.filter((r) => r.name.startsWith("cc"))) {
    assert.equal((await loadMemberByCode(row.name)).rank, row.rank, row.name);
  }
});

test("rejects non-GET", { skip }, async () => {
  assert.equal((await call("POST")).code, 405);
});
