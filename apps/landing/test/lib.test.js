import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPair, SignJWT } from "jose";
import { signSession, verifySession, verifyGoogleToken } from "../api/_lib.js";

const SECRET = "test-secret";
const ID = "0b0d6c1e-8a3f-4c55-9f0e-6f5a6a1e2b3c";

test("a signed session verifies", () => {
  assert.equal(verifySession(signSession(ID, SECRET), SECRET), ID);
});

test("a tampered id fails", () => {
  const [, sig] = signSession(ID, SECRET).split(".");
  assert.equal(verifySession(`${ID.replace("0b", "0c")}.${sig}`, SECRET), null);
});

test("a tampered signature fails", () => {
  const signed = signSession(ID, SECRET);
  const flipped = signed.slice(0, -1) + (signed.endsWith("0") ? "1" : "0");
  assert.equal(verifySession(flipped, SECRET), null);
  assert.equal(verifySession(`${ID}.short`, SECRET), null);
  assert.equal(verifySession(signed, "other-secret"), null);
  assert.equal(verifySession(undefined, SECRET), null);
});

// Local key pair standing in for Google's JWKS.
const AUD = "client-id.apps.googleusercontent.com";
const { publicKey, privateKey } = await generateKeyPair("RS256");
const keySet = async () => publicKey;

const mint = ({ aud = AUD, exp = "1h", claims = {} } = {}) =>
  new SignJWT({ email: "Me@Example.com", email_verified: true, ...claims })
    .setProtectedHeader({ alg: "RS256" })
    .setIssuer("https://accounts.google.com")
    .setAudience(aud)
    .setSubject("1234567890")
    .setIssuedAt()
    .setExpirationTime(exp)
    .sign(privateKey);

test("a valid token returns sub and lowercased email", async () => {
  const out = await verifyGoogleToken(await mint(), { audience: AUD, keySet });
  assert.deepEqual(out, { sub: "1234567890", email: "me@example.com" });
});

test("wrong audience is a 401", async () => {
  await assert.rejects(
    verifyGoogleToken(await mint({ aud: "someone-else" }), { audience: AUD, keySet }),
    { status: 401 },
  );
});

test("an expired token is a 401", async () => {
  const token = await mint({ exp: Math.floor(Date.now() / 1000) - 60 });
  await assert.rejects(verifyGoogleToken(token, { audience: AUD, keySet }), {
    status: 401,
  });
});

test("an unverified email is a 400", async () => {
  const token = await mint({ claims: { email_verified: false } });
  await assert.rejects(verifyGoogleToken(token, { audience: AUD, keySet }), {
    status: 400,
  });
});
