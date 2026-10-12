import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { PrismaClient, type Prisma } from "../src/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { saveInventoryPurchaseOrder as save } from "../src/lib/inventory-purchase-orders/service";
import { receiveInventoryPurchaseOrder as receive, readInventoryPurchaseOrderReceipts as read } from "../src/lib/inventory-purchase-orders/receiving-service";
import { createStockIn } from "../src/lib/inventory/service";
import { createOrder } from "../src/lib/orders/service";
import { recordManualPayment } from "../src/lib/payments/service";
import { saveRecipe } from "../src/lib/inventory/recipe-service";
import { closeShift } from "../src/lib/shifts/service";
import { weightedAverageCost } from "../src/lib/inventory/costing";

test("PO receiving posts exactly once with immutable variance and atomic inventory", async t => {
  assert.notEqual(process.env.NODE_ENV, "production");
  const url = new URL(process.env.DATABASE_URL!);
  assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(url.hostname));
  assert.match(url.pathname, /^\/aroom_access_test_[a-f0-9]{32}$/);
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: url.toString() }) });
  try {
    const [stock, finance, admin, cashier, procurement] = await Promise.all((["STOCK_MANAGEMENT", "FINANCE", "ADMIN", "CASHIER", "PROCUREMENT"] as const)
      .map(role => db.user.create({ data: { name: role, role, loginIdentifier: randomUUID(), passwordHash: "unused" } })));
    const supplier = await db.supplier.create({ data: { name: randomUUID() } });
    const expenseCount = await db.financeExpense.count(), paymentCount = await db.payment.count(), recipeCount = await db.recipe.count();
    const master = (baseUnit: "ml" | "g" | "pcs" = "ml") => db.ingredient.create({ data: { name: randomUUID(), baseUnit } });
    const line = (ingredientId: string, quantity = "10", unit = "L", price = 33333) => ({ id: randomUUID(), ingredientId, purchaseQuantity: quantity, purchaseUnit: unit, estimatedUnitPrice: price });
    const proposal = (name = randomUUID()) => ({ id: randomUUID(), proposedIngredient: { name, baseUnit: "ml" }, purchaseQuantity: "10", purchaseUnit: "L", estimatedUnitPrice: 33333 });
    const order = async (lines: (ReturnType<typeof line> | ReturnType<typeof proposal>)[], end = "ORDER") => {
      const id = randomUUID();
      await save(db, stock, { id, key: randomUUID(), revision: 0, operation: "CREATE", data: { supplierId: supplier.id, lines } });
      let revision = 1;
      if (end !== "DRAFT") for (const operation of ["SUBMIT", "APPROVE", "ORDER"]) {
        await save(db, operation === "APPROVE" ? finance : stock, { id, key: randomUUID(), revision: revision++, operation });
        if (operation === end) break;
      }
      return { id, revision, lines };
    };
    const delivery = (po: { id: string; revision: number }, lines: { lineId: string; quantity: string; unit: string; purchaseUnitCost: number;
      varianceReason?: string; resolution?: { type: string; ingredientId?: string } }[]) => ({ ...po, lines, key: randomUUID(), receivedAt: "2026-10-12T09:00:00+07:00" });
    const counts = async () => ({ receipts: await db.stockIn.count(), items: await db.stockInItem.count(), movements: await db.stockMovement.count(),
      ingredients: await db.ingredient.count(), events: await db.inventoryPurchaseOrderEvent.count(), audits: await db.auditLog.count(), expenses: await db.financeExpense.count(), payments: await db.payment.count() });
    const balance = (id: string) => db.ingredient.findUniqueOrThrow({ where: { id } });

    await t.test("6 L then 4 L posts immediately with different actual prices and backdated WAC order", async () => {
      const milk = await master(), po = await order([line(milk.id)]);
      const first = delivery(po, [{ lineId: po.lines[0].id, quantity: "6", unit: "L", purchaseUnitCost: 33333 }]);
      const one = await receive(db, stock, first);
      assert.equal(one.status, "PARTIALLY_RECEIVED");
      assert.equal((await balance(milk.id)).currentStock.toFixed(), "6000");
      assert.equal((await balance(milk.id)).weightedAverageUnitCostMicros, BigInt(33333000));
      const state = await read(db, finance, { id: po.id });
      assert.equal(state.lines[0].remainingBaseQuantity, "4000"); assert.equal(state.actualReceivedTotal, "199998");
      const second = { ...delivery({ id: po.id, revision: one.revision }, [{ lineId: po.lines[0].id, quantity: "4", unit: "L", purchaseUnitCost: 35000, varianceReason: "Supplier price increase" }]),
        receivedAt: "2026-10-01T09:00:00+07:00" };
      const two = await receive(db, stock, second);
      assert.equal(two.status, "RECEIVED");
      const after = await balance(milk.id);
      assert.equal(after.currentStock.toFixed(), "10000"); assert.equal(after.weightedAverageUnitCostMicros, BigInt(33999800));
      assert.equal(await db.stockMovement.count({ where: { ingredientId: milk.id } }), 2);
      const evidence = await read(db, finance, { id: po.id });
      assert.equal(evidence.lines[0].remainingBaseQuantity, "0"); assert.equal(evidence.actualReceivedTotal, "339998");
      const received = evidence.receipts.find(r => r.id === two.stockInId)!;
      assert.equal(received.items[0].approvedEstimatedAmountMicros, "133332000000");
      assert.equal(received.items[0].priceVarianceMicros, "6668000000");
      assert.equal(received.items[0].varianceReason, "Supplier price increase"); assert.equal(received.actorId, stock.id);
      const beforeReplay = await counts();
      assert.deepEqual(await receive(db, stock, first), one); assert.deepEqual(await receive(db, stock, second), two);
      assert.deepEqual(await counts(), beforeReplay);
      for (const patch of [{ notes: "changed" }, { revision: 99 }, { receivedAt: "2026-10-13T09:00:00+07:00" },
        { lines: [{ ...second.lines[0], varianceReason: "different" }] }, { lines: [{ ...second.lines[0], purchaseUnitCost: 35001 }] }]) {
        await assert.rejects(receive(db, stock, { ...second, ...patch }), { code: "IDEMPOTENCY_CONFLICT" });
      }
      await assert.rejects(receive(db, stock, { ...second, key: randomUUID(), revision: two.revision }), { code: "INVALID_TRANSITION" });
      await assert.rejects(db.stockInItem.update({ where: { id: received.items[0].id }, data: { varianceReason: "tamper" } }), /immutable/);
    });
    await t.test("one-line full receipt, multi-line full receipt and independent line progress", async () => {
      const a = await master("g"), b = await master("pcs");
      const single = await order([line(a.id, "1", "kg", 10000)]);
      assert.equal((await receive(db, stock, delivery(single, [{ lineId: single.lines[0].id, quantity: "1000", unit: "g", purchaseUnitCost: 10 }]))).status, "RECEIVED");
      for (const split of [false, true]) {
        const po = await order([line(a.id, "1", "kg", 10000), line(b.id, "2", "pcs", 500)]);
        const received = [{ lineId: po.lines[0].id, quantity: "1", unit: "kg", purchaseUnitCost: 9000 }, { lineId: po.lines[1].id, quantity: "2", unit: "pcs", purchaseUnitCost: 500 }];
        const first = await receive(db, stock, delivery(po, split ? [received[0]] : received));
        assert.equal(first.status, split ? "PARTIALLY_RECEIVED" : "RECEIVED");
        if (split) {
          assert.equal((await read(db, admin, { id: po.id })).lines[1].receivedBaseQuantity, "0");
          assert.equal((await receive(db, stock, delivery({ id: po.id, revision: first.revision }, [received[1]]))).status, "RECEIVED");
        }
      }
    });
    await t.test("variance requires a reason only for increases; fractional estimates stay exact", async () => {
      const milk = await master(), po = await order([line(milk.id, "1", "L", 33333)]);
      const input = delivery(po, [{ lineId: po.lines[0].id, quantity: "1", unit: "ml", purchaseUnitCost: 34 }]);
      const before = await counts();
      await assert.rejects(receive(db, stock, input), { code: "VARIANCE_REASON_REQUIRED" });
      assert.deepEqual(await counts(), before);
      const result = await receive(db, stock, { ...input, lines: [{ ...input.lines[0], varianceReason: "Rounded supplier invoice" }] });
      const evidence = (await read(db, finance, { id: po.id })).receipts[0].items[0];
      assert.equal(evidence.actualAmount, 34); assert.equal(evidence.approvedEstimatedAmountMicros, "33333000"); assert.equal(evidence.priceVarianceMicros, "667000");
      await receive(db, stock, delivery({ id: po.id, revision: result.revision }, [{ lineId: po.lines[0].id, quantity: "1", unit: "ml", purchaseUnitCost: 33 }]));
    });
    await t.test("explicit new master resolution persists from first receipt and cannot change later", async () => {
      const proposed = proposal(), po = await order([proposed]);
      const input = delivery(po, [{ lineId: proposed.id, quantity: "6", unit: "L", purchaseUnitCost: 33333, resolution: { type: "CREATE" } }]);
      const one = await receive(db, stock, input);
      const state = await read(db, finance, { id: po.id }), resolved = state.lines[0].resolvedIngredientId!;
      assert.equal((await balance(resolved)).name, proposed.proposedIngredient.name);
      assert.equal((await balance(resolved)).currentStock.toFixed(), "6000");
      assert.equal(await db.recipeItem.count({ where: { ingredientId: resolved } }), 0);
      const later = delivery({ id: po.id, revision: one.revision }, [{ lineId: proposed.id, quantity: "4", unit: "L", purchaseUnitCost: 33000 }]);
      await assert.rejects(receive(db, stock, { ...later, lines: [{ ...later.lines[0], resolution: { type: "EXISTING", ingredientId: (await master()).id } }] }), { code: "INGREDIENT_UNAVAILABLE" });
      await receive(db, stock, later);
      assert.equal((await balance(resolved)).currentStock.toFixed(), "10000");
      assert.equal((await db.inventoryPurchaseOrderLine.findUniqueOrThrow({ where: { id: proposed.id } })).ingredientId, null);
      assert.deepEqual(await receive(db, stock, input), one);
      await assert.rejects(receive(db, stock, { ...input, lines: [{ ...input.lines[0], resolution: { type: "EXISTING", ingredientId: resolved } }] }), { code: "IDEMPOTENCY_CONFLICT" });
    });
    await t.test("duplicate proposed names require explicit compatible selection, never fuzzy matching", async () => {
      const proposed = proposal(), po = await order([proposed]);
      const actual = await db.ingredient.create({ data: { name: proposed.proposedIngredient.name.toUpperCase(), baseUnit: "ml" } });
      const input = delivery(po, [{ lineId: proposed.id, quantity: "10", unit: "L", purchaseUnitCost: 33333, resolution: { type: "CREATE" } }]);
      await assert.rejects(receive(db, stock, input), { code: "DUPLICATE_INGREDIENT" });
      const wrong = await master("g");
      await assert.rejects(receive(db, stock, { ...input, lines: [{ ...input.lines[0], resolution: { type: "EXISTING", ingredientId: wrong.id } }] }), { code: "INGREDIENT_UNAVAILABLE" });
      await receive(db, stock, { ...input, lines: [{ ...input.lines[0], resolution: { type: "EXISTING", ingredientId: actual.id } }] });
      assert.equal((await balance(actual.id)).currentStock.toFixed(), "10000");
      const shared = proposal(), a = await order([shared]), bLine = { ...shared, id: randomUUID() }, b = await order([bLine]);
      const results = await Promise.allSettled([receive(db, stock, delivery(a, [{ lineId: shared.id, quantity: "10", unit: "L", purchaseUnitCost: 33333, resolution: { type: "CREATE" } }])),
        receive(db, stock, delivery(b, [{ lineId: bLine.id, quantity: "10", unit: "L", purchaseUnitCost: 33333, resolution: { type: "CREATE" } }]))]);
      assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
      assert.equal(await db.ingredient.count({ where: { name: shared.proposedIngredient.name } }), 1);
    });
    await t.test("invalid quantities, states and permissions cause no posting", async () => {
      const milk = await master(), po = await order([line(milk.id)]);
      const input = delivery(po, [{ lineId: po.lines[0].id, quantity: "6", unit: "L", purchaseUnitCost: 33333 }]);
      const before = await counts();
      for (const user of [finance, admin, cashier, procurement, { ...cashier, role: "STOCK_MANAGEMENT" as const }]) await assert.rejects(receive(db, user, input), { code: "FORBIDDEN" });
      for (const user of [cashier, procurement]) await assert.rejects(read(db, user, { id: po.id }), { code: "FORBIDDEN" });
      await db.user.update({ where: { id: stock.id }, data: { active: false } });
      await assert.rejects(receive(db, stock, input), { code: "FORBIDDEN" });
      await db.user.update({ where: { id: stock.id }, data: { active: true } });
      for (const patch of [{ quantity: "11" }, { unit: "g" }, { lineId: randomUUID() }, { purchaseUnitCost: null }, { quantity: "0" }, { purchaseUnitCost: 1.5 }]) await assert.rejects(receive(db, stock, { ...input, lines: [{ ...input.lines[0], ...patch }] }));
      await assert.rejects(receive(db, stock, { ...input, lines: [input.lines[0], input.lines[0]] }));
      await assert.rejects(receive(db, stock, { ...input, revision: 3 }), { code: "STALE_REVISION" });
      assert.deepEqual(await counts(), before);
      for (const stage of ["DRAFT", "SUBMIT", "APPROVE"]) {
        const pending = await order([line(milk.id)], stage);
        await assert.rejects(receive(db, stock, delivery(pending, [{ ...input.lines[0], lineId: pending.lines[0].id }])), { code: "INVALID_TRANSITION" });
      }
      await db.supplier.update({ where: { id: supplier.id }, data: { active: false } });
      await assert.rejects(receive(db, stock, input), { code: "SUPPLIER_UNAVAILABLE" });
      await db.supplier.update({ where: { id: supplier.id }, data: { active: true } });
    });
    await t.test("same-key retries and competing revisions cannot double receive or overreceive", async () => {
      const milk = await master(), po = await order([line(milk.id)]);
      const first = delivery(po, [{ lineId: po.lines[0].id, quantity: "6", unit: "L", purchaseUnitCost: 33333 }]);
      const [a, b] = await Promise.all([receive(db, stock, first), receive(db, stock, first)]);
      assert.deepEqual(a, b);
      const more = delivery({ id: po.id, revision: a.revision }, [{ ...first.lines[0], quantity: "3" }]);
      const race = await Promise.allSettled([receive(db, stock, more), receive(db, stock, { ...more, key: randomUUID() })]);
      assert.equal(race.filter(r => r.status === "fulfilled").length, 1);
      assert.equal((await balance(milk.id)).currentStock.toFixed(), "9000");
      const state = await read(db, stock, { id: po.id });
      await assert.rejects(receive(db, stock, delivery({ id: po.id, revision: state.revision }, [{ ...first.lines[0], quantity: "2" }])), { code: "OVER_RECEIPT" });
    });
    await t.test("manual/PO key collisions and unknown existing WAC reject without partial effects", async () => {
      const milk = await master(), po = await order([line(milk.id)]);
      const key = randomUUID();
      const manual = { idempotencyKey: key, supplierId: supplier.id, receivedAt: "2026-10-12T09:00:00+07:00", items: [{ ingredientId: milk.id, quantity: "1", unit: "L", purchaseUnitCost: 33333 }] };
      await createStockIn(db, stock, manual);
      const input = { ...delivery(po, [{ lineId: po.lines[0].id, quantity: "1", unit: "L", purchaseUnitCost: 33333 }]), key };
      const before = await counts(), oldBalance = await balance(milk.id);
      await assert.rejects(receive(db, stock, input), { code: "IDEMPOTENCY_CONFLICT" });
      assert.deepEqual(await counts(), before); assert.deepEqual(await balance(milk.id), oldBalance);
      const valid = { ...input, key: randomUUID() };
      await receive(db, stock, valid);
      await assert.rejects(createStockIn(db, stock, { ...manual, idempotencyKey: valid.key }), { code: "IDEMPOTENCY_CONFLICT" });
      const unknown = await db.ingredient.create({ data: { name: randomUUID(), baseUnit: "ml", currentStock: "100" } });
      const proposed = proposal(), mixed = await order([line(unknown.id), proposed]);
      const failed = delivery(mixed, [{ lineId: mixed.lines[0].id, quantity: "1", unit: "L", purchaseUnitCost: 33333 },
        { lineId: proposed.id, quantity: "1", unit: "L", purchaseUnitCost: 33333, resolution: { type: "CREATE" } }]);
      const snapshot = await counts();
      await assert.rejects(receive(db, stock, failed), { code: "UNKNOWN_INGREDIENT_COST" });
      assert.deepEqual(await counts(), snapshot); assert.equal(await db.ingredient.count({ where: { name: proposed.proposedIngredient.name } }), 0);
    });
    const intercept = (field: "auditLog" | "stockMovement" | null, loseResponse = false) => new Proxy(db, { get(target, key) {
      if (key !== "$transaction") return Reflect.get(target, key);
      return async (work: (tx: Prisma.TransactionClient) => Promise<unknown>) => {
        const result = await db.$transaction(tx => work(new Proxy(tx, { get(client, property) {
          if (property === field) return { create: async (args: { data: { action?: string } }) => {
            if (field === "stockMovement" || args.data.action === "INVENTORY_PO_RECEIVE") throw new Error("injected posting failure");
            return tx.auditLog.create(args as Prisma.AuditLogCreateArgs);
          } };
          return Reflect.get(client, property);
        } })), { timeout: 15000 });
        if (loseResponse) throw new Error("response lost after commit");
        return result;
      };
    } });
    await t.test("movement/audit failures roll back new masters, receipts, WAC, PO and all history", async () => {
      for (const field of ["stockMovement", "auditLog"] as const) {
        const proposed = proposal(), po = await order([proposed]);
        const input = delivery(po, [{ lineId: proposed.id, quantity: "10", unit: "L", purchaseUnitCost: 33333, resolution: { type: "CREATE" } }]);
        const before = await counts(), header = await db.inventoryPurchaseOrder.findUniqueOrThrow({ where: { id: po.id } });
        await assert.rejects(receive(intercept(field), stock, input), /injected posting failure/);
        assert.deepEqual(await counts(), before); assert.equal(await db.ingredient.count({ where: { name: proposed.proposedIngredient.name } }), 0);
        assert.deepEqual(await db.inventoryPurchaseOrder.findUniqueOrThrow({ where: { id: po.id } }), header);
        await receive(db, stock, input);
      }
      const milk = await master(), po = await order([line(milk.id)]), input = delivery(po, [{ lineId: po.lines[0].id, quantity: "10", unit: "L", purchaseUnitCost: 33333 }]);
      await assert.rejects(receive(intercept(null, true), stock, input), /response lost/);
      const before = await counts(); await receive(db, stock, input); assert.deepEqual(await counts(), before);
    });
    await t.test("PO receiving, manual receiving and a paid sale share serialized stock and WAC", async () => {
      const milk = await master();
      const manual = (quantity: string, price: number) => ({ idempotencyKey: randomUUID(), supplierId: supplier.id, receivedAt: "2026-10-12T09:00:00+07:00",
        items: [{ ingredientId: milk.id, quantity, unit: "L", purchaseUnitCost: price }] });
      const initial = await createStockIn(db, stock, manual("1", 30000));
      const po = await order([line(milk.id, "1", "L", 40000)]);
      const category = await db.category.create({ data: { name: randomUUID() } });
      const product = await db.product.create({ data: { name: randomUUID(), categoryId: category.id, price: 22000 } });
      await saveRecipe(db, admin, { productId: product.id, expectedRevision: null, idempotencyKey: randomUUID(), items: [{ ingredientId: milk.id, quantity: "100", unit: "ml" }] });
      const shift = await db.shift.create({ data: { cashierId: cashier.id, openingCash: 0 } });
      const sale = await createOrder(db, cashier, { createIdempotencyKey: randomUUID(), orderType: "DINE_IN", items: [{ productId: product.id, quantity: 1 }] });
      await Promise.all([receive(db, stock, delivery(po, [{ lineId: po.lines[0].id, quantity: "1", unit: "L", purchaseUnitCost: 40000 }])),
        createStockIn(db, stock, manual("1", 50000)), recordManualPayment(db, cashier, { orderId: sale.id, expectedRevision: sale.revision, method: "CASH", cashReceived: 22000, attemptIdentifier: randomUUID() })]);
      const final = await balance(milk.id); assert.equal(final.currentStock.toFixed(), "2900");
      const pending = await db.stockMovement.findMany({ where: { ingredientId: milk.id, sourceId: { not: initial.id } } });
      let stockQuantity = BigInt(1000), wac = BigInt(30000000);
      while (pending.length) {
        const index = pending.findIndex(m => BigInt(m.stockAfter.toFixed()) === stockQuantity + (m.type === "PURCHASE" ? BigInt(m.quantity.toFixed()) : -BigInt(m.quantity.toFixed())));
        assert.ok(index >= 0, "stockAfter identifies serialized posting order");
        const movement = pending.splice(index, 1)[0];
        if (movement.type === "PURCHASE") {
          const item = await db.stockInItem.findFirstOrThrow({ where: { stockInId: movement.sourceId!, ingredientId: milk.id } });
          wac = weightedAverageCost(stockQuantity.toString(), wac, movement.quantity.toFixed(), item.receivedUnitCostMicros!);
        }
        stockQuantity = BigInt(movement.stockAfter.toFixed());
      }
      assert.equal(final.weightedAverageUnitCostMicros, wac);
      await closeShift(db, cashier, { shiftId: shift.id, countedCash: 22000, discrepancyNote: null });
    });
    await t.test("supplier snapshots and manual retry contracts survive PO receiving", async () => {
      const milk = await master(), po = await order([line(milk.id)]), oldName = supplier.name;
      const input = delivery(po, [{ lineId: po.lines[0].id, quantity: "10", unit: "L", purchaseUnitCost: 33333 }]);
      const result = await receive(db, stock, input);
      await db.supplier.update({ where: { id: supplier.id }, data: { name: randomUUID(), active: false } });
      assert.deepEqual(await receive(db, stock, input), result);
      assert.equal((await read(db, finance, { id: po.id })).receipts[0].supplierName, oldName);
      await db.supplier.update({ where: { id: supplier.id }, data: { active: true } });
      const manual = { idempotencyKey: randomUUID(), supplierId: supplier.id, receivedAt: "2026-10-12T09:00:00+07:00", items: [{ ingredientId: milk.id, quantity: "1", unit: "ml", unitCost: 30 }] };
      const saved = await createStockIn(db, admin, manual);
      assert.deepEqual(await createStockIn(db, admin, manual), { ...saved, replayed: true });
      const row = await db.stockInItem.findUniqueOrThrow({ where: { id: saved.items[0].id } });
      assert.equal(row.purchaseOrderLineId, null); assert.equal(row.approvedEstimatedAmountMicros, null);
    });
    assert.equal(await db.financeExpense.count(), expenseCount);
    assert.equal(await db.payment.count(), paymentCount + 1); // Only the explicit POS regression sale.
    assert.equal(await db.recipe.count(), recipeCount + 1); // Only its explicit test recipe.
  } finally { await db.$disconnect(); }
});
