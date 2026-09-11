import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { createRequire } from "node:module";
import { decodeJwt, SignJWT } from "jose";
import { hashPassword } from "./password";
import { SESSION_COOKIE_NAME } from "./cookie";

test("authentication backend with isolated database and request cookies", async (t) => {
  const originalSecret = process.env.SESSION_SECRET;
  const originalDatabase = process.env.DATABASE_URL;
  process.env.SESSION_SECRET = randomBytes(32).toString("base64");
  process.env.DATABASE_URL ??= "postgresql://unused:unused@localhost:1/unused";
  const { prisma } = await import("../db");
  const require = createRequire(import.meta.url);
  const headers = require("next/headers");
  // Plain Node does not apply Next's server-component navigation alias.
  // Use the real server redirect implementation without importing client hooks.
  const navigationPath = require.resolve("next/navigation");
  const originalNavigation = require.cache[navigationPath];
  const serverNavigationPath = require.resolve("next/dist/client/components/navigation.react-server");
  require(serverNavigationPath);
  require.cache[navigationPath] = require.cache[serverNavigationPath];
  let cookie: string | undefined;
  let options: Record<string, unknown> = {};
  let writes = 0;
  t.mock.method(headers, "cookies", async () => ({
    get: (name: string) => {
      assert.equal(name, SESSION_COOKIE_NAME);
      return cookie === undefined ? undefined : { value: cookie };
    },
    set: (name: string, value: string, settings: Record<string, unknown>) => {
      assert.equal(name, SESSION_COOKIE_NAME);
      cookie = value;
      options = settings;
      writes++;
    },
  }));
  const password = " isolated password ";
  const user = {
    id: "test-user", name: "Test", loginIdentifier: "admin", role: "ADMIN" as "ADMIN" | "CASHIER",
    active: true, passwordHash: await hashPassword(password),
  };
  let exists = true;
  let queries = 0;
  const safeUser = () => ({ id: user.id, name: user.name, loginIdentifier: user.loginIdentifier, role: user.role });
  const originalFindUnique = prisma.user.findUnique;
  const originalFindFirst = prisma.user.findFirst;
  prisma.user.findUnique = (async (args: { where: { loginIdentifier: string } }) => {
    queries++;
    return exists && args.where.loginIdentifier === user.loginIdentifier ? { ...user } : null;
  }) as unknown as typeof prisma.user.findUnique;
  prisma.user.findFirst = (async (args: { where: { id: string; active: boolean }; select: unknown }) => {
    queries++;
    assert.deepEqual(args.select, { id: true, name: true, loginIdentifier: true, role: true });
    assert.equal(args.where.active, true);
    return exists && user.active && args.where.id === user.id ? safeUser() : null;
  }) as unknown as typeof prisma.user.findFirst;
  const { authenticateCredentials } = await import("./credentials");
  const { createSession, getSessionIdentity } = await import("./session");
  const { getCurrentUser } = await import("./current-user");
  const { requireUser, requireRole } = await import("./authorization");
  const { loginAction, logoutAction } = await import("./actions");
  try {
    await t.test("authorization guards use current database state for the same session", async () => {
      const redirectsTo = (path: string) => (error: unknown) => {
        assert.equal((error as { digest?: string }).digest, `NEXT_REDIRECT;replace;${path};307;`);
        return true;
      };
      try {
        cookie = undefined;
        await assert.rejects(requireUser(), redirectsTo("/login"));
        await assert.rejects(requireRole("ADMIN"), redirectsTo("/login"));
        await createSession(user.id);
        const originalCookie = cookie;
        assert.deepEqual(await requireUser(), safeUser());
        assert.deepEqual(await requireRole("ADMIN"), safeUser());
        user.role = "CASHIER";
        assert.deepEqual(await requireUser(), safeUser());
        await assert.rejects(requireRole("ADMIN"), redirectsTo("/"));
        assert.deepEqual(await requireRole("CASHIER"), safeUser());
        user.role = "ADMIN";
        assert.deepEqual(await requireRole("ADMIN"), safeUser());
        user.active = false;
        assert.equal(await getCurrentUser(), null);
        await assert.rejects(requireUser(), redirectsTo("/login"));
        await assert.rejects(requireRole("ADMIN"), redirectsTo("/login"));
        user.active = true;
        exists = false;
        assert.equal(await getCurrentUser(), null);
        await assert.rejects(requireUser(), redirectsTo("/login"));
        await assert.rejects(requireRole("ADMIN"), redirectsTo("/login"));
        assert.equal(cookie === originalCookie, true);
      } finally {
        user.active = true;
        user.role = "ADMIN";
        exists = true;
        cookie = undefined;
        writes = 0;
      }
    });
    await t.test("unknown users perform real Argon2id verification with a fixed valid dummy", async () => {
      const argon2 = createRequire(import.meta.url)("@node-rs/argon2");
      const verify = argon2.verify;
      const hashes: string[] = [];
      const spy = t.mock.method(argon2, "verify", async (hash: string, input: string) => {
        hashes.push(hash);
        return verify(hash, input);
      });
      try {
        assert.equal(await authenticateCredentials("unknown", password), null);
        assert.equal(await authenticateCredentials("another-unknown", password), null);
        assert.equal(hashes.length, 2);
        assert.equal(hashes[0], hashes[1]);
        assert.equal(hashes[0].split("$").slice(1, 4).join("$"), user.passwordHash.split("$").slice(1, 4).join("$"));
        // A match proves this is a valid hash, rather than a cheap parse failure.
        const publicDummy = "aroom-public-dummy-password-not-a-credential";
        assert.equal(await verify(hashes[0], publicDummy), true);
        assert.equal(await authenticateCredentials("unknown", publicDummy), null);
        assert.equal(await authenticateCredentials("admin", "wrong password"), null);
        assert.equal(hashes.length, 4);
        assert.equal(hashes[3] === user.passwordHash, true);
        user.active = false;
        assert.equal(await authenticateCredentials("admin", password), null);
        assert.equal(hashes.length, 5);
      } finally {
        user.active = true;
        spy.mock.restore();
      }
    });
    await t.test("normalized credentials succeed and return only safe fields", async () => {
      assert.deepEqual(await authenticateCredentials("  ADMIN  ", password), safeUser());
      assert.equal(await authenticateCredentials("admin", password.trim()), null);
    });
    await t.test("all credential failures have the same result and create no cookie", async () => {
      const failures: [unknown, unknown][] = [
        ["admin", "wrong password"], ["unknown", password], ["", password], ["  ", password],
        [null, password], [123, password], ["admin", null], ["admin", {}],
        ["a".repeat(129), password], ["admin", "a".repeat(129)], ["admin", "😀".repeat(129)],
        ["admin", "a".repeat(100000)],
      ];
      for (const [identifier, input] of failures) {
        assert.equal(await authenticateCredentials(identifier, input), null);
        assert.deepEqual(await loginAction(identifier, input), { success: false, error: "Login atau password salah." });
      }
      user.active = false;
      assert.equal(await authenticateCredentials("admin", password), null);
      assert.deepEqual(await loginAction("admin", password), { success: false, error: "Login atau password salah." });
      user.active = true;
      assert.equal(writes, 0);
      const before = queries;
      await authenticateCredentials("admin", "x".repeat(100000));
      assert.equal(queries, before);
    });
    await t.test("login creates a fixed lifetime signed identity cookie", async () => {
      assert.deepEqual(await loginAction("admin", password), { success: true });
      assert.deepEqual(await getSessionIdentity(), { userId: user.id });
      const claims = decodeJwt(cookie!);
      assert.deepEqual(Object.keys(claims).sort(), ["aud", "exp", "iat", "iss", "userId"]);
      assert.equal(claims.exp! - claims.iat!, 43200);
      assert.equal(options.maxAge, 43200);
      assert.equal(options.path, "/");
      assert.equal(options.httpOnly, true);
      assert.equal(options.sameSite, "lax");
    });
    await t.test("current user reloads role and active status every time without renewal", async () => {
      const before = writes;
      assert.deepEqual(await getCurrentUser(), safeUser());
      user.role = "CASHIER";
      assert.deepEqual(await getCurrentUser(), safeUser());
      user.active = false;
      assert.equal(await getCurrentUser(), null);
      user.active = true;
      exists = false;
      assert.equal(await getCurrentUser(), null);
      exists = true;
      assert.equal(writes, before);
    });
    await t.test("missing, malformed, tampered, expired and role-bearing tokens fail closed", async () => {
      const now = Math.floor(Date.now() / 1000);
      const claims = { userId: user.id, iss: "aroom-pos", aud: "aroom-pos:staff-session", iat: now, exp: now + 43200 };
      const key = new TextEncoder().encode(process.env.SESSION_SECRET);
      const sign = (payload: typeof claims & { role?: string }, secret = key) =>
        new SignJWT(payload).setProtectedHeader({ alg: "HS256", typ: "JWT" }).sign(secret);
      const invalid = [undefined, "malformed", `${cookie}x`,
        await sign(claims, randomBytes(32)),
        await sign({ ...claims, iat: now - 43201, exp: now - 1 }),
        await sign({ ...claims, role: "ADMIN" }),
      ];
      const before = queries;
      for (cookie of invalid) {
        assert.equal(await getSessionIdentity(), null);
        assert.equal(await getCurrentUser(), null);
        await assert.rejects(requireRole("ADMIN"), (error: unknown) => {
          assert.equal((error as { digest?: string }).digest, "NEXT_REDIRECT;replace;/login;307;");
          return true;
        });
      }
      assert.equal(queries, before);
    });
    await t.test("logout expires the cookie at the original path and is repeatable", async () => {
      await createSession(user.id);
      assert.deepEqual(await logoutAction(), { success: true });
      assert.equal(cookie, "");
      assert.equal(options.path, "/");
      assert.equal(options.maxAge, 0);
      assert.deepEqual(options.expires, new Date(0));
      assert.equal(await getSessionIdentity(), null);
      assert.deepEqual(await logoutAction(), { success: true });
    });
  } finally {
    prisma.user.findUnique = originalFindUnique;
    prisma.user.findFirst = originalFindFirst;
    t.mock.restoreAll();
    if (originalNavigation) require.cache[navigationPath] = originalNavigation;
    else delete require.cache[navigationPath];
    if (originalSecret === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = originalSecret;
    if (originalDatabase === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDatabase;
    await prisma.$disconnect();
  }
});
