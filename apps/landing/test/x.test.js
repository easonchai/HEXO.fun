import test from "node:test";
import assert from "node:assert/strict";
import { percentEncode, signatureBaseString, sign, authHeader } from "../api/_x.js";

// Worked example from X's "Creating a signature" doc.
const method = "POST";
const url = "https://api.twitter.com/1.1/statuses/update.json";
const params = {
  status: "Hello Ladies + Gentlemen, a signed OAuth request!",
  include_entities: "true",
  oauth_consumer_key: "xvz1evFS4wEEPTGEFPHBog",
  oauth_nonce: "kYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg",
  oauth_signature_method: "HMAC-SHA1",
  oauth_timestamp: "1318622958",
  oauth_token: "370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb",
  oauth_version: "1.0",
};
const consumerSecret = "kAcSOqF21Fu85e7zjz7ZN2U4ZRhfV3WpwPAoE3Z7kBw";
const tokenSecret = "LswwdoUaIvS8ltyTt5jkRh4J50vUPVVHtR2YPi5kE";

test("percentEncode is RFC 3986", () => {
  assert.equal(percentEncode("Ladies + Gentlemen"), "Ladies%20%2B%20Gentlemen");
  assert.equal(percentEncode("!*'()"), "%21%2A%27%28%29");
});

test("base string matches the doc", () => {
  assert.equal(
    signatureBaseString(method, url, params),
    "POST&https%3A%2F%2Fapi.twitter.com%2F1.1%2Fstatuses%2Fupdate.json&include_entities%3Dtrue%26oauth_consumer_key%3Dxvz1evFS4wEEPTGEFPHBog%26oauth_nonce%3DkYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg%26oauth_signature_method%3DHMAC-SHA1%26oauth_timestamp%3D1318622958%26oauth_token%3D370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb%26oauth_version%3D1.0%26status%3DHello%2520Ladies%2520%252B%2520Gentlemen%252C%2520a%2520signed%2520OAuth%2520request%2521",
  );
});

test("signature matches the doc", () => {
  assert.equal(
    sign({ method, url, params, consumerSecret, tokenSecret }),
    "hCtSmYh+iHYCEqBWrE7C7hYmtUk=",
  );
});

test("authHeader signs oauth params plus extra and encodes the signature", () => {
  const h = authHeader({
    method: "POST",
    url: "https://api.x.com/oauth/request_token",
    consumerKey: "ck",
    consumerSecret: "cs",
    extra: { oauth_callback: "https://example.com/cb?a=b" },
    nonce: "n",
    timestamp: 1,
  });
  assert.match(h, /^OAuth /);
  assert.ok(h.includes('oauth_callback="https%3A%2F%2Fexample.com%2Fcb%3Fa%3Db"'));
  assert.ok(h.includes('oauth_nonce="n"'));
  assert.ok(!h.includes("oauth_token="));
  const expected = sign({
    method: "POST",
    url: "https://api.x.com/oauth/request_token",
    params: {
      oauth_callback: "https://example.com/cb?a=b",
      oauth_consumer_key: "ck",
      oauth_nonce: "n",
      oauth_signature_method: "HMAC-SHA1",
      oauth_timestamp: "1",
      oauth_version: "1.0",
    },
    consumerSecret: "cs",
  });
  assert.ok(h.includes(`oauth_signature="${percentEncode(expected)}"`));
});

// ----------------------------- temp cookie ----------------------------------
import { xCookie, readXCookie } from "../api/_x.js";
import { signSession } from "../api/_lib.js";

const reqWith = (cookie) => ({ headers: { cookie } });
const valueOf = (setCookie) => setCookie.split(";")[0];

test("x cookie round-trips token and secret", () => {
  const c = xCookie("tok", "sec", "S");
  assert.match(c, /Max-Age=600/);
  assert.match(c, /Path=\/api\/x/);
  assert.deepEqual(readXCookie(reqWith(`a=b; ${valueOf(c)}`), "S"), { token: "tok", secret: "sec" });
});

test("x cookie rejects a wrong secret, tampering and a session cookie", () => {
  const v = valueOf(xCookie("tok", "sec", "S"));
  assert.equal(readXCookie(reqWith(v), "other"), null);
  assert.equal(readXCookie(reqWith(v.replace("hexo_x=", "hexo_x=z")), "S"), null);
  assert.equal(readXCookie(reqWith(`hexo_x=${signSession("just-an-id", "S")}`), "S"), null);
  assert.equal(readXCookie(reqWith(""), "S"), null);
});
