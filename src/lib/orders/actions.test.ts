import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { test } from "node:test";
import { OrderError, type OrderErrorCode } from "./domain";
import { SESSION_COOKIE_NAME } from "../auth/cookie";

test("authenticated order application boundary", async (t) => {
  const originalSecret = process.env.SESSION_SECRET;
  const originalDatabase = process.env.DATABASE_URL;
  process.env.SESSION_SECRET = randomBytes(32).toString("base64");
  process.env.DATABASE_URL ??= "postgresql://unused:unused@localhost:1/unused";
  const require = createRequire(import.meta.url);
  const navigationPath = require.resolve("next/navigation");
  const originalNavigation = require.cache[navigationPath];
  const serverNavigationPath = require.resolve("next/dist/client/components/navigation.react-server");
  require(serverNavigationPath);
  require.cache[navigationPath] = require.cache[serverNavigationPath];
  const { prisma } = await import("../db");
  const services = await import("./service");
  const servicePath = require.resolve("./service");
  const serviceModule = require.cache[servicePath]!;
  const originalExports = serviceModule.exports;
  let cookie: string | undefined;
  let active = true;
  let authFailure = false;
  const user = { id: randomUUID(), name: "Cashier", loginIdentifier: "cashier", role: "CASHIER" as "CASHIER" | "ADMIN" };
  const id = randomUUID();
  const createInput = { createIdempotencyKey: randomUUID(), orderType: "DINE_IN", items: [{ productId: id, quantity: 1 }] };
  const editInput = { orderId: id, expectedRevision: 1, operation: { type: "SET_QUANTITY", orderItemId: id, quantity: 2 } };
  const cancelInput = { orderId: id, expectedRevision: 1, cancellationReason: "  Salah pesanan  " };
  const dto = { id, orderNumber: "AR-000042", status: "UNPAID", revision: 1, shiftId: id,
    cashierId: user.id, orderType: "DINE_IN", total: 22000, createdAt: "2026-09-15T00:00:00.000Z",
    items: [{ id, productId: id, productName: "Coffee", unitPrice: 22000, quantity: 1, lineTotal: 22000 }] };
  const calls: { actor: unknown; input: unknown; name: string }[] = [];
  let failure: unknown;
  let useRealService = false;
  let replayed = false;
  serviceModule.exports = Object.fromEntries((["createOrder", "editOrder", "cancelOrder"] as const).map((name) => [name,
    async (db: typeof prisma, actor: typeof user, input: unknown) => {
      assert.equal(db, prisma);
      calls.push({ name, actor, input });
      if (useRealService) return services[name](db, actor, input);
      if (failure) throw failure;
      return { ...dto, status: name === "cancelOrder" ? "CANCELLED" : "UNPAID", replayed,
        createIdempotencyKey: "secret", createRequestFingerprint: "secret", payments: ["secret"],
        items: dto.items.map((item) => ({ ...item, internal: "secret" })) };
    },
  ]));
  t.mock.method(require("next/headers"), "cookies", async () => ({
    get: (name: string) => { assert.equal(name, SESSION_COOKIE_NAME); return cookie ? { value: cookie } : undefined; },
  }));
  const originalUserRead = prisma.user.findFirst;
  const originalOrderRead = prisma.order.findUnique;
  const originalTransaction = prisma.$transaction;
  prisma.user.findFirst = (async (args: { where: { id: string; active: boolean } }) => {
    assert.deepEqual(args.where, { id: user.id, active: true });
    if (authFailure) throw new Error("secret PostgreSQL credentials");
    return active ? { ...user } : null;
  }) as unknown as typeof prisma.user.findFirst;
  // Any DB work after validation in these boundary tests is an error.
  prisma.order.findUnique = (async () => { throw new Error("unexpected order lookup"); }) as unknown as typeof prisma.order.findUnique;
  prisma.$transaction = async () => { throw new Error("unexpected transaction"); };
  const { signSessionToken } = await import("../auth/session-token");
  const { createOrderAction, editOrderAction, cancelOrderAction } = await import("./actions");
  const cases = [
    { action: createOrderAction, input: createInput, fallback: "CREATE_FAILED" },
    { action: editOrderAction, input: editInput, fallback: "UPDATE_FAILED" },
    { action: cancelOrderAction, input: cancelInput, fallback: "CANCEL_FAILED" },
  ] as const;
  try {
    await t.test("every action redirects missing/invalid/inactive sessions before service calls", async () => {
      const token = await signSessionToken({ userId: user.id });
      for (const state of [{ cookie: undefined, active: true }, { cookie: "invalid", active: true }, { cookie: token, active: false }]) {
        cookie = state.cookie;
        active = state.active;
        for (const { action, input } of cases) {
          await assert.rejects(action(input), (error: unknown) =>
            (error as { digest?: string }).digest === "NEXT_REDIRECT;replace;/login;307;");
        }
      }
      assert.equal(calls.length, 0);
      active = true;
      cookie = token;
    });
    await t.test("fresh database actors, original intent and explicit serializable DTOs", async () => {
      for (const role of ["CASHIER", "ADMIN"] as const) {
        user.role = role;
        for (const { action, input } of cases) {
          const result = await action(input);
          assert.ok(result.success);
          assert.deepEqual(calls.at(-1)?.actor, user);
          assert.equal(calls.at(-1)?.input, input);
          const expected = { ...dto, status: action === cancelOrderAction ? "CANCELLED" : "UNPAID",
            ...(action === createOrderAction ? { replayed: false } : {}) };
          assert.deepEqual(result.order, expected);
          assert.deepEqual(JSON.parse(JSON.stringify(result.order)), expected);
        }
      }
      replayed = true;
      const recovered = await createOrderAction(createInput);
      assert.ok(recovered.success && recovered.order.replayed);
      assert.equal(calls.at(-1)?.input, createInput);
    });
    await t.test("real services reject forged identity, money and malformed requests", async () => {
      useRealService = true;
      for (const { action, input } of cases) {
        for (const field of ["actorId", "userId", "cashierId", "role", "shiftId", "total", "unitPrice"]) {
          const result = await action({ ...input, [field]: "forged" });
          assert.ok(!result.success);
          assert.equal(result.code, "INVALID_INPUT");
        }
        for (const invalid of [null, [], "bad", {}]) assert.equal((await action(invalid)).success, false);
      }
      assert.equal((await createOrderAction({ ...createInput, items: [{ ...createInput.items[0], role: "ADMIN" }] })).success, false);
      assert.equal((await editOrderAction({ ...editInput, operation: { ...editInput.operation, shiftId: id } })).success, false);
      assert.equal((await cancelOrderAction({ ...cancelInput, expectedRevision: "1" })).success, false);
      useRealService = false;
    });
    await t.test("all controlled errors use safe messages; unknown and auth errors are sanitized", async () => {
      const codes: OrderErrorCode[] = ["INVALID_INPUT", "INVALID_IDEMPOTENCY_KEY", "IDEMPOTENCY_CONFLICT", "NO_ACTIVE_SHIFT", "FORBIDDEN", "PRODUCT_NOT_FOUND", "PRODUCT_UNAVAILABLE", "INVALID_QUANTITY", "TOO_MANY_ITEMS", "MONEY_OVERFLOW", "CREATE_FAILED", "ORDER_NOT_FOUND", "ORDER_NOT_EDITABLE", "REVISION_CONFLICT", "ORDER_ITEM_NOT_FOUND", "EMPTY_ORDER_NOT_ALLOWED", "PAYMENT_BLOCKED", "UPDATE_FAILED", "CANCEL_FAILED"];
      for (const { action, input, fallback } of cases) {
        for (const code of codes) {
          failure = new OrderError(code);
          (failure as Error).message = "secret SQL details";
          const result = await action(input);
          assert.ok(!result.success);
          assert.equal(result.code, code);
          assert.equal(typeof result.error, "string");
          assert.ok(result.error.length > 10);
          assert.deepEqual(Object.keys(result).sort(), ["code", "error", "success"]);
          assert.ok(!JSON.stringify(result).includes("secret"));
        }
        for (failure of [new Error("secret Prisma failure"), { code: "FORBIDDEN", message: "secret" }, new OrderError("UNKNOWN" as OrderErrorCode)]) {
          const result = await action(input);
          assert.ok(!result.success);
          assert.equal(result.code, fallback);
          assert.ok(!JSON.stringify(result).includes("secret"));
          assert.match(result.error, action === createOrderAction ? /yang sama/ : /muat ulang pesanan/);
        }
        failure = undefined;
        authFailure = true;
        const before = calls.length;
        const result = await action(input);
        assert.ok(!result.success);
        assert.equal(result.code, fallback);
        assert.equal(calls.length, before);
        authFailure = false;
      }
    });
  } finally {
    prisma.user.findFirst = originalUserRead;
    prisma.order.findUnique = originalOrderRead;
    prisma.$transaction = originalTransaction;
    serviceModule.exports = originalExports;
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
