import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { Prisma, PrismaClient } from "../src/generated/prisma/client";
import { createMenu, deleteMenu, saveRecipe } from "../src/lib/inventory/recipe-service";

test("menu deletion PostgreSQL authorization, history preservation, atomicity and replay", async t => {
  assert.notEqual(process.env.NODE_ENV, "production");
  const url = new URL(process.env.DATABASE_URL!);
  assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(url.hostname));
  assert.match(url.pathname, /^\/aroom_access_test_/);
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: url.toString() }) });
  try {
    const user = (role: "ADMIN" | "CASHIER" | "STOCK_MANAGEMENT" | "FINANCE") => db.user.create({
      data: { name: role, role, loginIdentifier: randomUUID(), passwordHash: "unused" },
    });
    const admin = await user("ADMIN"), otherAdmin = await user("ADMIN"), cashier = await user("CASHIER"),
      stock = await user("STOCK_MANAGEMENT"), finance = await user("FINANCE");
    const category = await db.category.create({ data: { name: randomUUID() } });
    const ingredient = await db.ingredient.create({ data: { name: randomUUID(), baseUnit: "ml", currentStock: "1000", weightedAverageUnitCostMicros: BigInt(30000000) } });
    const product = (withRecipe = true) => db.product.create({ data: {
      name: randomUUID(), categoryId: category.id, price: 22000,
      ...(withRecipe ? { recipe: { create: { items: { create: [{ ingredientId: ingredient.id, quantity: "100", unit: "ml" }] } } } } : {}),
    }, include: { recipe: { include: { items: true } } } });
    const request = (productId: string) => ({ productId, idempotencyKey: randomUUID() });
    const shift = await db.shift.create({ data: { cashierId: cashier.id, openingCash: 0, status: "CLOSED", closedAt: new Date(), expectedCash: 0, countedCash: 0, variance: 0 } });
    const orderData = (p: { id: string; name: string; price: number }, status: "UNPAID" | "PAID" | "CANCELLED" = "UNPAID") => ({
      orderNumber: randomUUID(), shiftId: shift.id, cashierId: cashier.id, orderType: "DINE_IN" as const, status, total: p.price,
      createIdempotencyKey: randomUUID(), createRequestFingerprint: "fixture",
      paidAt: status === "PAID" ? new Date() : null, cancelledAt: status === "CANCELLED" ? new Date() : null,
      items: { create: [{ productId: p.id, productNameSnapshot: p.name, unitPriceSnapshot: p.price, quantity: 1, lineTotal: p.price }] },
    });
    const protectedHistory = async () => ({
      ingredients: await db.ingredient.findMany({ orderBy: { id: "asc" } }),
      movements: await db.stockMovement.findMany({ orderBy: { id: "asc" } }),
      orders: await db.order.findMany({ orderBy: { id: "asc" }, include: { items: { orderBy: { id: "asc" } }, payments: { orderBy: { id: "asc" } } } }),
      receiving: await db.stockIn.findMany({ orderBy: { id: "asc" }, include: { items: { orderBy: { id: "asc" } } } }),
    });

    await t.test("unused products with and without recipes delete once, including simultaneous and later retries", async () => {
      for (const withRecipe of [true, false]) {
        const p = await product(withRecipe), input = request(p.id), before = await protectedHistory();
        const results = await Promise.all([deleteMenu(db, admin, input), deleteMenu(db, admin, input)]);
        assert.equal(results.filter(row => row.replayed).length, 1);
        assert.ok(results.every(row => row.outcome === "DELETED" && row.productId === p.id));
        assert.equal(await db.product.findUnique({ where: { id: p.id } }), null);
        assert.equal(await db.recipe.count({ where: { productId: p.id } }), 0);
        if (p.recipe) assert.equal(await db.recipeItem.count({ where: { recipeId: p.recipe.id } }), 0);
        assert.deepEqual(await deleteMenu(db, admin, input), { productId: p.id, outcome: "DELETED", replayed: true });
        assert.equal(await db.auditLog.count({ where: { id: input.idempotencyKey } }), 1);
        const audit = await db.auditLog.findUniqueOrThrow({ where: { id: input.idempotencyKey } });
        assert.equal(audit.action, "MENU_DELETED"); assert.equal(audit.entityId, p.id);
        assert.deepEqual(await protectedHistory(), before);
        await assert.rejects(deleteMenu(db, admin, request(p.id)), { code: "PRODUCT_NOT_FOUND" });
        await assert.rejects(deleteMenu(db, admin, { ...input, productId: randomUUID() }), { code: "IDEMPOTENCY_CONFLICT" });
        await assert.rejects(deleteMenu(db, otherAdmin, input), { code: "IDEMPOTENCY_CONFLICT" });
      }
    });

    await t.test("paid, unpaid and cancelled history archives only flags; receipts, recipes, payments and stock are unchanged", async () => {
      for (const status of ["PAID", "UNPAID", "CANCELLED"] as const) {
        const p = await product(), input = request(p.id);
        const order = await db.order.create({ data: orderData(p, status) });
        if (status === "PAID") {
          const payment = await db.payment.create({ data: { orderId: order.id, method: "CASH", status: "SUCCEEDED", amount: p.price,
            cashReceived: p.price, changeAmount: 0, succeededAt: order.paidAt, attemptIdentifier: randomUUID() } });
          await db.stockMovement.create({ data: { ingredientId: ingredient.id, unit: "ml", quantity: "100", stockAfter: "1000",
            type: "SALE_CONSUMPTION", sourceType: "Payment", sourceId: payment.id, paymentId: payment.id, actorId: cashier.id } });
        }
        const before = await protectedHistory(), audits = await db.auditLog.findMany({ orderBy: { id: "asc" } });
        const results = await Promise.all([deleteMenu(db, admin, input), deleteMenu(db, admin, input)]);
        assert.ok(results.every(row => row.outcome === "ARCHIVED")); assert.equal(results.filter(row => row.replayed).length, 1);
        const after = await db.product.findUniqueOrThrow({ where: { id: p.id }, include: { recipe: { include: { items: true } } } });
        assert.deepEqual(after, { ...p, active: false, available: false, updatedAt: after.updatedAt });
        assert.equal(await db.product.count({ where: { id: p.id, active: true } }), 0);
        assert.deepEqual(await protectedHistory(), before);
        assert.deepEqual(await db.auditLog.findMany({ where: { id: { in: audits.map(row => row.id) } }, orderBy: { id: "asc" } }), audits);
        assert.deepEqual(await deleteMenu(db, admin, input), { productId: p.id, outcome: "ARCHIVED", replayed: true });
        assert.deepEqual(await db.product.findUniqueOrThrow({ where: { id: p.id }, include: { recipe: { include: { items: true } } } }), after);
        assert.equal(await db.auditLog.count({ where: { id: input.idempotencyKey } }), 1);
        // Even a fresh request does not rewrite an already archived Product.
        await deleteMenu(db, admin, request(p.id));
        assert.deepEqual(await db.product.findUniqueOrThrow({ where: { id: p.id }, include: { recipe: { include: { items: true } } } }), after);
      }
    });

    await t.test("authorization is reread for first calls and replays; forged and revoked actors cannot mutate", async () => {
      const p = await product(), input = request(p.id), count = await db.auditLog.count();
      for (const actor of [stock, finance, cashier, { ...stock, role: "ADMIN" as const }, { ...admin, id: randomUUID() }]) {
        await assert.rejects(deleteMenu(db, actor, input), { code: "FORBIDDEN" });
      }
      const stale = await user("ADMIN");
      await db.user.update({ where: { id: stale.id }, data: { active: false } });
      await assert.rejects(deleteMenu(db, stale, input), { code: "FORBIDDEN" });
      await db.user.update({ where: { id: stale.id }, data: { active: true, role: "FINANCE" } });
      await assert.rejects(deleteMenu(db, stale, input), { code: "FORBIDDEN" });
      assert.deepEqual(await db.product.findUniqueOrThrow({ where: { id: p.id }, include: { recipe: { include: { items: true } } } }), p);
      assert.equal(await db.auditLog.count(), count);
      await db.user.update({ where: { id: stale.id }, data: { role: "ADMIN" } });
      await deleteMenu(db, stale, input);
      await db.user.update({ where: { id: stale.id }, data: { active: false } });
      await assert.rejects(deleteMenu(db, stale, input), { code: "FORBIDDEN" });
      assert.equal(await db.auditLog.count({ where: { id: input.idempotencyKey } }), 1);
    });

    const intercept = (wrap: (tx: Prisma.TransactionClient) => Prisma.TransactionClient, loseResponse = false) => new Proxy(db, {
      get(target, key) {
        if (key !== "$transaction") return Reflect.get(target, key);
        return async (work: (tx: Prisma.TransactionClient) => Promise<unknown>) => {
          const result = await db.$transaction(tx => work(wrap(tx)));
          if (loseResponse) throw new Error("lost response after commit");
          return result;
        };
      },
    });

    await t.test("failures at recipe/product/audit writes roll back every change; lost response replays the committed receipt", async () => {
      for (const failedModel of ["recipe", "product", "auditLog"] as const) {
        for (const archive of [false, true]) {
          if (archive && failedModel === "recipe") continue;
          const p = await product(), input = request(p.id);
          if (archive) await db.order.create({ data: orderData(p) });
          const broken = intercept(tx => new Proxy(tx, { get(target, key) {
            if (key !== failedModel) return Reflect.get(target, key);
            return new Proxy(target[failedModel], { get(model, method) {
              if (["delete", "update", "create"].includes(String(method))) return async () => { throw new Error("injected deletion failure"); };
              return Reflect.get(model, method);
            } });
          } }));
          await assert.rejects(deleteMenu(broken, admin, input), /injected deletion failure/);
          assert.deepEqual(await db.product.findUniqueOrThrow({ where: { id: p.id }, include: { recipe: { include: { items: true } } } }), p);
          assert.equal(await db.auditLog.count({ where: { id: input.idempotencyKey } }), 0);
          const lost = intercept(tx => tx, true);
          await assert.rejects(deleteMenu(lost, admin, input), /lost response after commit/);
          assert.deepEqual(await deleteMenu(db, admin, input), { productId: p.id, outcome: archive ? "ARCHIVED" : "DELETED", replayed: true });
          assert.equal(await db.auditLog.count({ where: { id: input.idempotencyKey } }), 1);
        }
      }
    });

    await t.test("creation keys cannot be reused for deletion and recipe saves serialize with deletion", async () => {
      const input = { name: randomUUID(), categoryId: category.id, price: 22000, idempotencyKey: randomUUID(), items: [{ ingredientId: ingredient.id, quantity: "100", unit: "ml" }] };
      const created = await createMenu(db, admin, input);
      await assert.rejects(deleteMenu(db, admin, { productId: created.productId, idempotencyKey: input.idempotencyKey }), { code: "IDEMPOTENCY_CONFLICT" });
      const p = await product(), deletion = request(p.id);
      const results = await Promise.allSettled([
        deleteMenu(db, admin, deletion),
        saveRecipe(db, admin, { productId: p.id, expectedRevision: 1, idempotencyKey: randomUUID(), items: input.items }),
      ]);
      assert.equal(results[0].status, "fulfilled");
      if (results[1].status === "rejected") assert.equal(results[1].reason.code, "PRODUCT_NOT_FOUND");
      assert.equal(await db.product.count({ where: { id: p.id } }), 0);
      assert.equal(await db.recipe.count({ where: { productId: p.id } }), 0);
      assert.equal(await db.recipeItem.count({ where: { recipeId: p.recipe!.id } }), 0);
    });

    await t.test("an order reference committing while deletion waits is detected and preserved", async () => {
      const p = await product(), input = request(p.id);
      let release!: () => void, referenceReady!: () => void, deleteLockStarted!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      const ready = new Promise<void>(resolve => { referenceReady = resolve; });
      const lockStarted = new Promise<void>(resolve => { deleteLockStarted = resolve; });
      const writer = db.$transaction(async tx => {
        const order = await tx.order.create({ data: orderData(p) });
        referenceReady(); await gate; return order;
      });
      await ready;
      const observed = intercept(tx => new Proxy(tx, { get(target, key) {
        if (key !== "$queryRaw") return Reflect.get(target, key);
        return (sql: TemplateStringsArray, ...values: unknown[]) => {
          if (sql.join("").includes('FROM "Product"')) deleteLockStarted();
          return target.$queryRaw(sql, ...values);
        };
      } }));
      const deletion = deleteMenu(observed, admin, input);
      try { await lockStarted; } finally { release(); }
      const [order, deleted] = await Promise.all([writer, deletion]);
      assert.equal(deleted.outcome, "ARCHIVED");
      assert.equal(await db.orderItem.count({ where: { orderId: order.id, productId: p.id } }), 1);
      assert.ok(await db.recipe.findUnique({ where: { productId: p.id } }));
    });
  } finally { await db.$disconnect(); }
});
