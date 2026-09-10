import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { decodeJwt, SignJWT } from "jose";
import { normalizeLoginIdentifier } from "./login-identifier";
import { validatePassword } from "./password-validation";
import { hashPassword, verifyPassword } from "./password";
import { getSessionCookieOptions, SESSION_COOKIE_NAME, SESSION_LIFETIME_SECONDS } from "./cookie";

test("identifier normalization is deterministic and idempotent", () => {
  assert.equal(normalizeLoginIdentifier("  Cashier01  "), "cashier01");
  assert.equal(normalizeLoginIdentifier("\tADMIN\n"), "admin");
  assert.equal(normalizeLoginIdentifier("cashier01"), "cashier01");
});

test("password policy counts characters without composition or transformation", () => {
  for (const length of [0, 11, 129]) assert.equal(validatePassword("a".repeat(length)), false);
  for (const length of [12, 128]) assert.equal(validatePassword("a".repeat(length)), true);
  assert.equal(validatePassword("😀".repeat(11)), false);
  assert.equal(validatePassword("😀".repeat(128)), true);
  assert.equal(validatePassword(" aaaaaaaaaa "), true);
});

test("Argon2id uses fresh salts and safely verifies passwords and invalid hashes", async () => {
  const password = " aroom staff password ";
  const first = await hashPassword(password);
  const second = await hashPassword(password);
  assert.match(first, /^\$argon2id\$/);
  assert.notEqual(first, second);
  assert.equal(await verifyPassword(first, password), true);
  assert.equal(await verifyPassword(first, password.trim()), false);
  assert.equal(await verifyPassword(first, "wrong password"), false);
  for (const invalid of ["", "invalid", "$argon2id$v=19$broken"]) {
    assert.equal(await verifyPassword(invalid, password), false);
  }
  await assert.rejects(hashPassword("short"), /12 to 128/);
  await assert.rejects(hashPassword("a".repeat(129)), /12 to 128/);
});

test("session imports are lazy; tokens enforce identity, signature and lifetime", async () => {
  const original = process.env.SESSION_SECRET;
  try {
    delete process.env.SESSION_SECRET;
    const { signSessionToken, verifySessionToken } = await import("./session-token");
    await assert.rejects(signSessionToken({ userId: "staff-1" }), /SESSION_SECRET/);
    await assert.rejects(verifySessionToken("invalid"), /SESSION_SECRET/);
    process.env.SESSION_SECRET = "too-short";
    await assert.rejects(signSessionToken({ userId: "staff-1" }), /SESSION_SECRET/);
    process.env.SESSION_SECRET = randomBytes(32).toString("base64");
    const token = await signSessionToken({ userId: "staff-1" });
    const claims = decodeJwt(token);
    assert.deepEqual(Object.keys(claims).sort(), ["aud", "exp", "iat", "iss", "userId"]);
    assert.equal(claims.exp! - claims.iat!, 43200);
    assert.deepEqual(await verifySessionToken(token), { userId: "staff-1", iat: claims.iat, exp: claims.exp });
    for (const invalid of ["", "malformed", `${token}x`]) {
      assert.equal(await verifySessionToken(invalid), null);
    }
    const key = new TextEncoder().encode(process.env.SESSION_SECRET);
    const now = Math.floor(Date.now() / 1000);
    const base = { userId: "staff-1", iss: "aroom-pos", aud: "aroom-pos:staff-session", iat: now, exp: now + 43200 };
    for (const overrides of [
      { iat: now - 43201, exp: now - 1 },
      { iat: now + 60, exp: now + 43260 },
      { iss: "another-app" }, { aud: "another-app" },
      { userId: " " }, { userId: 123 }, { userId: undefined },
      { exp: undefined }, { iat: undefined }, { exp: now + 86400 },
      { role: "ADMIN" },
    ]) {
      const invalid = await new SignJWT({ ...base, ...overrides })
        .setProtectedHeader({ alg: "HS256", typ: "JWT" }).sign(key);
      assert.equal(await verifySessionToken(invalid), null);
    }
    const wrongAlgorithm = await new SignJWT(base)
      .setProtectedHeader({ alg: "HS384", typ: "JWT" }).sign(randomBytes(48));
    assert.equal(await verifySessionToken(wrongAlgorithm), null);
    process.env.SESSION_SECRET = randomBytes(32).toString("base64");
    assert.equal(await verifySessionToken(token), null);
    await assert.rejects(signSessionToken({ userId: "" }), /userId/);
  } finally {
    if (original === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = original;
  }
});

test("cookie settings match the session lifetime and production security", () => {
  const original = process.env.NODE_ENV;
  try {
    assert.equal(SESSION_COOKIE_NAME, "aroom_session");
    Object.assign(process.env, { NODE_ENV: "production" });
    assert.deepEqual(getSessionCookieOptions(), {
      httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge: SESSION_LIFETIME_SECONDS,
    });
    Object.assign(process.env, { NODE_ENV: "development" });
    assert.equal(getSessionCookieOptions().secure, false);
  } finally {
    if (original === undefined) Reflect.deleteProperty(process.env, "NODE_ENV");
    else Object.assign(process.env, { NODE_ENV: original });
  }
});
