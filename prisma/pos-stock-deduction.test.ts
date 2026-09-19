import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { Prisma, PrismaClient } from "../src/generated/prisma/client";
import { createOrder, cancelOrder, editOrder } from "../src/lib/orders/service";
import { recordManualPayment } from "../src/lib/payments/service";
import { closeShift } from "../src/lib/shifts/service";
import { saveRecipe } from "../src/lib/inventory/recipe-service";
import { createStockIn, createSupplier } from "../src/lib/inventory/service";

test("7G PostgreSQL sale stock, atomicity, concurrency and durable replay", async t => {
  assert.notEqual(process.env.NODE_ENV, "production");
  const url = new URL(process.env.DATABASE_URL!);
  assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(url.hostname));
  assert.match(url.pathname, /^\/aroom_(payment|access)_test_/);
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: url.toString() }) });
  try {
    const user = (role: "ADMIN" | "CASHIER" | "FINANCE" | "STOCK_MANAGEMENT") => db.user.create({ data: { name: role, role, loginIdentifier: randomUUID(), passwordHash: "unused" } });
    const cashier = await user("CASHIER"), admin = await user("ADMIN"), finance = await user("FINANCE"), stock = await user("STOCK_MANAGEMENT");
    const shift = await db.shift.create({ data: { cashierId: cashier.id, openingCash: 0 } });
    const category = await db.category.create({ data: { name: randomUUID() } });
    const ingredient = (baseUnit: "ml" | "g" | "pcs", currentStock = "1000") => db.ingredient.create({ data: {
      name: randomUUID(), baseUnit, currentStock, weightedAverageUnitCostMicros: BigInt(10000000),
    } });
    const product = () => db.product.create({ data: { name: randomUUID(), categoryId: category.id, price: 22000 } });
    const recipe = (productId: string, items: { ingredientId: string; quantity: string; unit: string }[], expectedRevision: number | null = null) =>
      saveRecipe(db, admin, { productId, items, expectedRevision, idempotencyKey: randomUUID() });
    const order = (items: { productId: string; quantity: number }[]) => createOrder(db, cashier, { createIdempotencyKey: randomUUID(), orderType: "DINE_IN", items });
    const request = (saved: { id: string; revision: number }) => ({ orderId: saved.id, expectedRevision: saved.revision, attemptIdentifier: randomUUID(), method: "CASH", cashReceived: 1000000 });
    const balance = async (id: string) => (await db.ingredient.findUniqueOrThrow({ where: { id } })).currentStock.toFixed();
    const movements = (paymentId: string) => db.stockMovement.findMany({ where: { paymentId }, orderBy: { ingredientId: "asc" } });
    const oat = await ingredient("ml"), matcha = await ingredient("g"), cup = await ingredient("pcs");
    const latte = await product(), other = await product();
    await recipe(latte.id, [{ ingredientId: oat.id, quantity: "120", unit: "ml" }, { ingredientId: matcha.id, quantity: "5", unit: "g" }, { ingredientId: cup.id, quantity: "1", unit: "pcs" }]);
    await recipe(other.id, [{ ingredientId: oat.id, quantity: "10", unit: "ml" }]);
    let committedRequest!: ReturnType<typeof request>;
    let committedPayment!: Awaited<ReturnType<typeof recordManualPayment>>;

    await t.test("recipes and unpaid/cancelled/failed/pending/expired attempts consume nothing", async () => {
      assert.equal(await balance(oat.id), "1000");
      const saved = await order([{ productId: latte.id, quantity: 2 }]);
      const input = request(saved);
      for (const status of ["FAILED", "EXPIRED", "CANCELLED", "PENDING"] as const) {
        const attempt = await db.payment.create({ data: { orderId: saved.id, amount: saved.total, method: "MIDTRANS_QRIS", status, attemptIdentifier: randomUUID() } });
        if (status === "PENDING") {
          await assert.rejects(recordManualPayment(db, cashier, input), { code: "PAYMENT_BLOCKED" });
          await db.payment.update({ where: { id: attempt.id }, data: { status: "EXPIRED" } });
        }
      }
      await cancelOrder(db, cashier, { orderId: saved.id, expectedRevision: saved.revision });
      await assert.rejects(recordManualPayment(db, cashier, input), { code: "ORDER_NOT_PAYABLE" });
      assert.equal(await balance(oat.id), "1000");
      assert.equal(await db.stockMovement.count({ where: { ingredientId: oat.id } }), 0);
    });

    await t.test("shared ingredients aggregate all products and duplicate lines; concurrent identical retries consume once", async () => {
      const initial = await order([{ productId: latte.id, quantity: 2 }, { productId: other.id, quantity: 1 }]);
      const saved = await editOrder(db, cashier, { orderId: initial.id, expectedRevision: initial.revision, operation: { type: "ADD_ITEM", productId: other.id, quantity: 2 } });
      assert.equal(saved.items.filter(item => item.productId === other.id).length, 2);
      committedRequest = request(saved);
      const before = await db.orderItem.findMany({ where: { orderId: saved.id }, orderBy: { id: "asc" } });
      const results = await Promise.all([recordManualPayment(db, cashier, committedRequest), recordManualPayment(db, cashier, committedRequest)]);
      committedPayment = results[0];
      assert.equal(results[0].id, results[1].id);
      assert.equal(results.filter(result => result.replayed).length, 1);
      assert.equal(await balance(oat.id), "730"); assert.equal(await balance(matcha.id), "990"); assert.equal(await balance(cup.id), "998");
      const rows = await movements(results[0].id);
      assert.equal(rows.length, 3);
      const milk = rows.find(row => row.ingredientId === oat.id)!;
      assert.equal(milk.quantity.toFixed(), "270"); assert.equal(milk.unit, "ml"); assert.equal(milk.stockAfter.toFixed(), "730");
      assert.equal(milk.sourceType, "Payment"); assert.equal(milk.sourceId, results[0].id); assert.equal(milk.actorId, cashier.id);
      assert.ok(milk.createdAt instanceof Date);
      assert.equal((await db.payment.findUniqueOrThrow({ where: { id: milk.paymentId! } })).orderId, saved.id);
      await assert.rejects(db.stockMovement.create({ data: { ...milk, id: randomUUID() } }));
      await assert.rejects(db.stockMovement.update({ where: { id: milk.id }, data: { quantity: "1" } }));
      await assert.rejects(db.stockMovement.delete({ where: { id: milk.id } }));
      assert.deepEqual(await db.orderItem.findMany({ where: { orderId: saved.id }, orderBy: { id: "asc" } }), before);
      assert.equal((await db.ingredient.findUniqueOrThrow({ where: { id: oat.id } })).weightedAverageUnitCostMicros, BigInt(10000000));
      const second = await order([{ productId: other.id, quantity: 1 }]);
      await recordManualPayment(db, cashier, { orderId: second.id, expectedRevision: second.revision, attemptIdentifier: randomUUID(), method: "BCA_EDC", edcReference: "approved" });
      assert.equal(await balance(oat.id), "720");
    });

    await t.test("missing/empty recipe, inactive ingredient and insufficient stock roll back every financial row", async () => {
      const p = await product(), empty = await product();
      await db.recipe.create({ data: { productId: empty.id } });
      for (const productId of [p.id, empty.id]) {
        const saved = await order([{ productId, quantity: 1 }]);
        await assert.rejects(recordManualPayment(db, cashier, request(saved)), { code: "RECIPE_NOT_CONFIGURED" });
        assert.equal(await db.payment.count({ where: { orderId: saved.id } }), 0);
      }
      const saved = await order([{ productId: latte.id, quantity: 1 }]);
      const input = request(saved);
      await db.ingredient.update({ where: { id: matcha.id }, data: { active: false } });
      await assert.rejects(recordManualPayment(db, cashier, input), { code: "RECIPE_INGREDIENT_INACTIVE" });
      await db.ingredient.update({ where: { id: matcha.id }, data: { active: true, currentStock: "0" } });
      await assert.rejects(recordManualPayment(db, cashier, input), { code: "INSUFFICIENT_STOCK" });
      assert.equal(await balance(oat.id), "720"); assert.equal(await balance(cup.id), "998");
      assert.equal(await db.payment.count({ where: { orderId: saved.id } }), 0);
      assert.equal((await db.order.findUniqueOrThrow({ where: { id: saved.id } })).revision, 1);
      assert.equal((await db.order.findUniqueOrThrow({ where: { id: saved.id } })).status, "UNPAID");
      await db.ingredient.update({ where: { id: matcha.id }, data: { currentStock: "990" } });
      // Unknown WAC does not prevent quantity consumption.
      await db.ingredient.update({ where: { id: oat.id }, data: { weightedAverageUnitCostMicros: null } });
      await recordManualPayment(db, cashier, input);
      assert.equal(await balance(oat.id), "600");
      assert.equal((await db.ingredient.findUniqueOrThrow({ where: { id: oat.id } })).weightedAverageUnitCostMicros, null);
    });

    await t.test("two simultaneous 150 ml sales against 200 ml allow exactly one commit", async () => {
      const milk = await ingredient("ml", "200"), p = await product();
      await recipe(p.id, [{ ingredientId: milk.id, quantity: "150", unit: "ml" }]);
      const a = await order([{ productId: p.id, quantity: 1 }]), b = await order([{ productId: p.id, quantity: 1 }]);
      const results = await Promise.allSettled([recordManualPayment(db, cashier, request(a)), recordManualPayment(db, cashier, request(b))]);
      assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
      const failure = results.find(result => result.status === "rejected") as PromiseRejectedResult;
      assert.equal(failure.reason.code, "INSUFFICIENT_STOCK");
      assert.equal(await balance(milk.id), "50");
      assert.equal(await db.stockMovement.count({ where: { ingredientId: milk.id } }), 1);
      assert.equal(await db.payment.count({ where: { orderId: { in: [a.id, b.id] }, status: "SUCCEEDED" } }), 1);
    });

    // Inject failures into real transactions, after inventory writes have occurred.
    const intercept = (wrap: (tx: Prisma.TransactionClient) => Prisma.TransactionClient, loseResponse = false) => new Proxy(db, { get(target, key) {
      if (key !== "$transaction") return Reflect.get(target, key);
      return async (work: (tx: Prisma.TransactionClient) => Promise<unknown>) => {
        const value = await db.$transaction(tx => work(wrap(tx)));
        if (loseResponse) throw new Error("lost response after commit");
        return value;
      };
    } });

    await t.test("failure on a later movement or final audit rolls back all stock, movements, payment and order", async () => {
      for (const field of ["stockMovement", "auditLog"] as const) {
        const saved = await order([{ productId: latte.id, quantity: 1 }]);
        const input = request(saved);
        const originalStock = await db.ingredient.findMany({ where: { id: { in: [oat.id, matcha.id, cup.id] } }, orderBy: { id: "asc" } });
        const count = await db.stockMovement.count();
        let writes = 0;
        const broken = intercept(tx => new Proxy(tx, { get(target, key) {
          if (key === field) return { create: async (args: never) => {
            if (field === "auditLog" || ++writes === 2) throw new Error("injected failure");
            return tx.stockMovement.create(args);
          } };
          return Reflect.get(target, key);
        } }));
        await assert.rejects(recordManualPayment(broken, cashier, input), { code: "PAYMENT_FAILED" });
        assert.equal(await db.payment.count({ where: { orderId: saved.id } }), 0);
        assert.equal((await db.order.findUniqueOrThrow({ where: { id: saved.id } })).status, "UNPAID");
        assert.equal(await db.stockMovement.count(), count);
        assert.deepEqual(await db.ingredient.findMany({ where: { id: { in: [oat.id, matcha.id, cup.id] } }, orderBy: { id: "asc" } }), originalStock);
      }
    });

    await t.test("lost commit response and later recipe/WAC changes replay the saved payment without new consumption", async () => {
      const saved = await order([{ productId: other.id, quantity: 1 }]);
      const input = request(saved);
      const lost = intercept(tx => tx, true);
      await assert.rejects(recordManualPayment(lost, cashier, input), { code: "PAYMENT_FAILED" });
      const before = await balance(oat.id);
      const payment = await db.payment.findUniqueOrThrow({ where: { attemptIdentifier: input.attemptIdentifier } });
      const history = await movements(payment.id);
      await recipe(other.id, [{ ingredientId: oat.id, quantity: "500", unit: "ml" }], 1);
      await db.ingredient.update({ where: { id: oat.id }, data: { weightedAverageUnitCostMicros: BigInt(99000000), active: false } });
      assert.equal((await recordManualPayment(db, cashier, input)).replayed, true);
      assert.equal(await balance(oat.id), before);
      assert.deepEqual(await movements(payment.id), history);
      await db.ingredient.update({ where: { id: oat.id }, data: { active: true } });
    });

    await t.test("recipe save waits for sale's Product lock; sale consumes one complete revision", async () => {
      const milk = await ingredient("ml", "200"), p = await product();
      await recipe(p.id, [{ ingredientId: milk.id, quantity: "10", unit: "ml" }]);
      const saved = await order([{ productId: p.id, quantity: 1 }]);
      let ready!: () => void, release!: () => void;
      const locked = new Promise<void>(resolve => { ready = resolve; });
      const resume = new Promise<void>(resolve => { release = resolve; });
      const paused = intercept(tx => new Proxy(tx, { get(target, key) {
        if (key === "recipe") return { findMany: async (args: never) => {
          const rows = await tx.recipe.findMany(args); ready(); await resume; return rows;
        } };
        return Reflect.get(target, key);
      } }));
      const sale = recordManualPayment(paused, cashier, request(saved));
      await locked;
      try {
        // NOWAIT proves the lock is held, without timing-dependent assertions.
        await assert.rejects(db.$transaction(tx => tx.$queryRaw`SELECT id FROM "Product" WHERE id = ${p.id}::uuid FOR UPDATE NOWAIT`));
      } finally { release(); }
      const edit = recipe(p.id, [{ ingredientId: milk.id, quantity: "100", unit: "ml" }], 1);
      const paid = await sale; await edit;
      assert.equal((await movements(paid.id))[0].quantity.toFixed(), "10");
      assert.equal(await balance(milk.id), "190");
      const next = await order([{ productId: p.id, quantity: 1 }]);
      await recordManualPayment(db, cashier, request(next));
      assert.equal(await balance(milk.id), "90");
    });

    await t.test("receiving and sale serialize shared inventory and retain receiving WAC", async () => {
      const milk = await ingredient("ml", "200"), p = await product();
      await recipe(p.id, [{ ingredientId: milk.id, quantity: "150", unit: "ml" }]);
      const supplier = await createSupplier(db, stock, { name: randomUUID() });
      const saved = await order([{ productId: p.id, quantity: 1 }]);
      const [paid, received] = await Promise.all([
        recordManualPayment(db, cashier, request(saved)),
        createStockIn(db, stock, { idempotencyKey: randomUUID(), supplierId: supplier.id, receivedAt: "2026-09-20T12:00:00+07:00", items: [{ ingredientId: milk.id, quantity: "100", unit: "ml", purchaseUnitCost: 20 }] }),
      ]);
      assert.equal(await balance(milk.id), "150");
      const purchase = await db.stockMovement.findFirstOrThrow({ where: { sourceId: received.id } });
      const wac = (await db.ingredient.findUniqueOrThrow({ where: { id: milk.id } })).weightedAverageUnitCostMicros;
      assert.equal(wac, purchase.stockAfter.equals(300) ? BigInt(13333333) : BigInt(16666667));
      assert.equal((await movements(paid.id)).length, 1);
    });

    await t.test("existing operational authorization, closed-shift recovery and historical snapshots remain intact", async () => {
      const snapshot = await db.order.findUniqueOrThrow({ where: { id: committedRequest.orderId }, include: { items: true } });
      for (const actor of [finance, stock]) await assert.rejects(recordManualPayment(db, actor, committedRequest), { code: "FORBIDDEN" });
      await db.product.update({ where: { id: latte.id }, data: { name: "New menu name", price: 33000 } });
      assert.deepEqual(await db.order.findUniqueOrThrow({ where: { id: snapshot.id }, include: { items: true } }), snapshot);
      for (const unpaid of await db.order.findMany({ where: { shiftId: shift.id, status: "UNPAID" } })) {
        await cancelOrder(db, cashier, { orderId: unpaid.id, expectedRevision: unpaid.revision });
      }
      const totals = await db.payment.aggregate({ where: { order: { shiftId: shift.id }, method: "CASH", status: "SUCCEEDED" }, _sum: { amount: true } });
      await closeShift(db, cashier, { shiftId: shift.id, countedCash: totals._sum.amount ?? 0 });
      const history = await movements(committedPayment.id);
      assert.equal((await recordManualPayment(db, cashier, committedRequest)).replayed, true);
      assert.deepEqual(await movements(committedPayment.id), history);
    });
  } finally { await db.$disconnect(); }
});
