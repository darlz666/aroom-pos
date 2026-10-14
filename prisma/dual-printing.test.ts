import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { test } from "node:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client";
import { fingerprintCreateRequest, normalizeCreateRequest } from "../src/lib/orders/domain";
import { cancelOrder, createOrder, editOrder } from "../src/lib/orders/service";
import { getReceipt } from "../src/lib/orders/receipt";
import { recordManualPayment } from "../src/lib/payments/service";
import { saveRecipe } from "../src/lib/inventory/recipe-service";
import { formatReceipt } from "../src/lib/printing/receipt-format";
import { formatCupLabels } from "../src/lib/printing/cup-label-format";
import { createCupLabelPrintJob, createReceiptPrintJob, createSimulatedLabelAdapter, createSimulatedReceiptAdapter } from "../src/lib/printing/printer";

test("dual printing snapshots, backward compatibility and financial isolation in disposable PostgreSQL", async t => {
  // Deliberately do not load dotenv: this test requires an explicit disposable URL.
  assert.equal(process.env.NODE_ENV, "test");
  assert.ok(process.env.DATABASE_URL);
  const url = new URL(process.env.DATABASE_URL);
  assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(url.hostname));
  assert.match(url.pathname, /^\/aroom_access_test_[a-f0-9]{32}$/);
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: url.toString() }) });
  const ids = [randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID()];
  const cashier = { id: ids[0], role: "CASHIER" as const };
  const admin = { id: ids[1], role: "ADMIN" as const };
  const other = { id: ids[2], role: "CASHIER" as const };
  const stock = { id: ids[3], role: "STOCK_MANAGEMENT" as const };
  const finance = { id: ids[4], role: "FINANCE" as const };
  const categoryId = randomUUID(), ingredientId = randomUUID(), shiftId = randomUUID();
  const snapshot = async () => ({
    users: await db.user.findMany({ orderBy: { id: "asc" } }),
    shifts: await db.shift.findMany({ orderBy: { id: "asc" } }),
    products: await db.product.findMany({ orderBy: { id: "asc" } }),
    categories: await db.category.findMany({ orderBy: { id: "asc" } }),
    orders: await db.order.findMany({ orderBy: { id: "asc" } }),
    items: await db.orderItem.findMany({ orderBy: { id: "asc" } }),
    payments: await db.payment.findMany({ orderBy: { id: "asc" } }),
    audits: await db.auditLog.findMany({ orderBy: { id: "asc" } }),
    ingredients: await db.ingredient.findMany({ orderBy: { id: "asc" } }),
    recipes: await db.recipe.findMany({ orderBy: { id: "asc" } }),
    recipeItems: await db.recipeItem.findMany({ orderBy: { id: "asc" } }),
    movements: await db.stockMovement.findMany({ orderBy: { id: "asc" } }),
  });
  let before: Awaited<ReturnType<typeof snapshot>> | undefined;
  try {
    const [identity] = await db.$queryRaw<{ name: string; schema: string }[]>`SELECT current_database() AS name, current_schema() AS schema`;
    assert.equal(identity.name, url.pathname.slice(1));
    assert.equal(identity.schema, "public");
    before = await snapshot();
    assert.equal(before.shifts.filter(shift => shift.status === "OPEN").length, 0);
    for (const actor of [cashier, admin, other, stock, finance]) await db.user.create({ data: {
      ...actor, name: "Dual print fixture", loginIdentifier: randomUUID(), passwordHash: "unused",
    } });
    await db.category.create({ data: { id: categoryId, name: randomUUID() } });
    await db.shift.create({ data: { id: shiftId, cashierId: cashier.id, openingCash: 0 } });
    await db.ingredient.create({ data: { id: ingredientId, name: randomUUID(), baseUnit: "ml", currentStock: "1000", weightedAverageUnitCostMicros: BigInt(1000000) } });
    const beverage = await db.product.create({ data: { categoryId, name: "Saved Latte", price: 22000 } });
    const food = await db.product.create({ data: { categoryId, name: "Saved Pastry", price: 5000 } });
    for (const [productId, quantity] of [[beverage.id, "120"], [food.id, "10"]]) await saveRecipe(db, admin, {
      productId, expectedRevision: null, idempotencyKey: randomUUID(), items: [{ ingredientId, quantity, unit: "ml" }],
    });
    const cups = [
      { sugar: "NORMAL", ice: "NORMAL", cup: "REGULAR", notes: "" },
      { sugar: "NO_SUGAR", ice: "LESS", cup: "LARGE", notes: "Extra hot request" },
    ];
    const customInput = {
      createIdempotencyKey: randomUUID(), orderType: "TAKEAWAY", customerName: "Dina",
      items: [{ productId: beverage.id, quantity: 2, notes: "Serve together", cups }, { productId: food.id, quantity: 1 }],
    };
    const customized = await createOrder(db, cashier, customInput);
    const beverageLine = customized.items.find(item => item.productId === beverage.id)!;

    await t.test("per-unit and customer snapshots persist; LARGE and instructions add no price", async () => {
      assert.equal(customized.customerName, "Dina");
      assert.equal(customized.total, 49000);
      assert.equal(beverageLine.unitPrice, 22000);
      assert.equal(beverageLine.lineTotal, 44000);
      assert.deepEqual(beverageLine.cups, cups);
      assert.equal(beverageLine.notes, "Serve together");
      assert.equal(customized.items.find(item => item.productId === food.id)!.cups, undefined);
      const persisted = await db.order.findUniqueOrThrow({ where: { id: customized.id }, include: { items: true } });
      assert.equal(persisted.customerName, "Dina");
      assert.deepEqual(persisted.items.find(item => item.productId === beverage.id)!.cupCustomizations, cups);
      assert.equal(persisted.items.find(item => item.productId === food.id)!.cupCustomizations, null);
      assert.equal((await db.ingredient.findUniqueOrThrow({ where: { id: ingredientId } })).currentStock.toFixed(), "1000");
    });

    await t.test("legacy normalization, fingerprints and duplicate-line retries remain compatible", async () => {
      const input = { createIdempotencyKey: randomUUID(), orderType: "DINE_IN", items: [{ productId: beverage.id, quantity: 2 }] };
      const normalized = normalizeCreateRequest(input);
      assert.deepEqual(normalized, input);
      const previousFingerprint = createHash("sha256").update(JSON.stringify({ orderType: input.orderType, items: input.items })).digest("hex");
      assert.equal(fingerprintCreateRequest(normalized), previousFingerprint);
      const legacy = await createOrder(db, cashier, input);
      assert.equal(legacy.customerName, undefined);
      assert.equal(legacy.items[0].cups, undefined);
      assert.equal(legacy.items[0].notes, undefined);
      const replay = await createOrder(db, cashier, { ...input, items: [{ productId: beverage.id, quantity: 1 }, { productId: beverage.id, quantity: 1 }] });
      assert.deepEqual(replay, { ...legacy, replayed: true });
      const row = await db.order.findUniqueOrThrow({ where: { id: legacy.id }, include: { items: true } });
      assert.equal(row.customerName, null);
      assert.equal(row.items[0].cupCustomizations, null);
      assert.equal(row.createRequestFingerprint, previousFingerprint);
    });

    await t.test("same-key customized concurrent retries create no duplicate rows or audit", async () => {
      const input = { ...customInput, createIdempotencyKey: randomUUID() };
      const results = await Promise.all([createOrder(db, cashier, input), createOrder(db, cashier, input)]);
      assert.equal(results[0].id, results[1].id);
      assert.equal(results.filter(result => result.replayed).length, 1);
      assert.equal(await db.order.count({ where: { createIdempotencyKey: input.createIdempotencyKey } }), 1);
      assert.equal(await db.orderItem.count({ where: { orderId: results[0].id } }), 2);
      assert.equal(await db.auditLog.count({ where: { entityId: results[0].id, action: "ORDER_CREATED" } }), 1);
      const split = await createOrder(db, cashier, { ...input, items: [
        { productId: beverage.id, quantity: 1, notes: "Serve together", cups: [cups[0]] },
        { productId: beverage.id, quantity: 1, notes: "Serve together", cups: [cups[1]] },
        input.items[1],
      ] });
      assert.equal(split.id, results[0].id);
      assert.equal(split.replayed, true);
      assert.deepEqual(split.items.find(item => item.productId === beverage.id)!.cups, cups);
      await assert.rejects(createOrder(db, cashier, { ...input, customerName: "Changed" }), { code: "IDEMPOTENCY_CONFLICT" });
      await assert.rejects(createOrder(db, cashier, { ...input, items: [{ productId: beverage.id, quantity: 2, cups: [...cups].reverse(), notes: "Serve together" }, input.items[1]] }), { code: "IDEMPOTENCY_CONFLICT" });
      await assert.rejects(createOrder(db, cashier, { ...input, items: [{ ...input.items[0], notes: "Changed" }, input.items[1]] }), { code: "IDEMPOTENCY_CONFLICT" });
    });

    await t.test("malformed per-cup data and text reject without order, item or audit writes", async () => {
      const counts = async () => [await db.order.count(), await db.orderItem.count(), await db.auditLog.count()];
      const initial = await counts();
      const invalid = [
        { ...customInput, customerName: "a".repeat(129) },
        { ...customInput, customerName: "Dina\nspoof" },
        { ...customInput, items: [{ productId: beverage.id, quantity: 2, cups: [cups[0]] }] },
        { ...customInput, items: [{ productId: beverage.id, quantity: 2, cups: [{ ...cups[0], sugar: "EXTRA" }, cups[1]] }] },
        { ...customInput, items: [{ productId: beverage.id, quantity: 2, cups: [{ ...cups[0], notes: "a".repeat(301) }, cups[1]] }] },
        { ...customInput, items: [{ productId: beverage.id, quantity: 2, cups: [{ ...cups[0], notes: "\u001bcommand" }, cups[1]] }] },
        { ...customInput, items: [{ productId: beverage.id, quantity: 1, cups: [cups[0]] }, { productId: beverage.id, quantity: 1 }] },
      ];
      for (const input of invalid) await assert.rejects(createOrder(db, cashier, { ...input, createIdempotencyKey: randomUUID() }), { code: "INVALID_INPUT" });
      assert.deepEqual(await counts(), initial);
    });

    await t.test("unpaid quantity changes preserve cup order and default only added units", async () => {
      const saved = await createOrder(db, cashier, { ...customInput, createIdempotencyKey: randomUUID() });
      const line = saved.items.find(item => item.productId === beverage.id)!;
      const increased = await editOrder(db, cashier, { orderId: saved.id, expectedRevision: saved.revision, operation: { type: "SET_QUANTITY", orderItemId: line.id, quantity: 3 } });
      assert.deepEqual(increased.items.find(item => item.id === line.id)!.cups, [...cups, { sugar: "NORMAL", ice: "NORMAL", cup: "REGULAR", notes: "" }]);
      assert.equal(increased.total, 71000);
      await assert.rejects(editOrder(db, cashier, { orderId: saved.id, expectedRevision: saved.revision, operation: { type: "SET_CUSTOMER", customerName: "Stale" } }), { code: "REVISION_CONFLICT" });
      const decreased = await editOrder(db, cashier, { orderId: saved.id, expectedRevision: increased.revision, operation: { type: "SET_QUANTITY", orderItemId: line.id, quantity: 1 } });
      assert.deepEqual(decreased.items.find(item => item.id === line.id)!.cups, [cups[0]]);
      assert.equal(decreased.total, 27000);
      const detailed = await editOrder(db, cashier, { orderId: saved.id, expectedRevision: decreased.revision, operation: { type: "SET_ITEM_DETAILS", orderItemId: line.id, cups: [cups[1]], notes: "Revised instruction" } });
      assert.deepEqual(detailed.items.find(item => item.id === line.id)!.cups, [cups[1]]);
      assert.equal(detailed.total, decreased.total);
      const renamed = await editOrder(db, cashier, { orderId: saved.id, expectedRevision: detailed.revision, operation: { type: "SET_CUSTOMER", customerName: "  Maya  " } });
      assert.equal(renamed.customerName, "Maya");
      const cleared = await editOrder(db, cashier, { orderId: saved.id, expectedRevision: renamed.revision, operation: { type: "SET_ITEM_DETAILS", orderItemId: line.id } });
      assert.equal(cleared.items.find(item => item.id === line.id)!.cups, undefined);
      assert.equal(cleared.items.find(item => item.id === line.id)!.notes, undefined);
      const noCustomer = await editOrder(db, cashier, { orderId: saved.id, expectedRevision: cleared.revision, operation: { type: "SET_CUSTOMER" } });
      assert.equal(noCustomer.customerName, undefined);
    });

    await t.test("adding a separately customized line preserves existing snapshots", async () => {
      const saved = await createOrder(db, cashier, { createIdempotencyKey: randomUUID(), orderType: "DINE_IN", items: [{ productId: food.id, quantity: 1 }] });
      const added = await editOrder(db, cashier, { orderId: saved.id, expectedRevision: saved.revision, operation: { type: "ADD_ITEM", productId: beverage.id, quantity: 2, cups, notes: "New line" } });
      assert.equal(added.total, 49000);
      assert.deepEqual(added.items.find(item => item.productId === beverage.id)!.cups, cups);
      assert.deepEqual(added.items.find(item => item.productId === food.id), saved.items[0]);
    });

    await t.test("pending payment prevents customer and cup snapshot mutations", async () => {
      const saved = await createOrder(db, cashier, { ...customInput, createIdempotencyKey: randomUUID() });
      const line = saved.items.find(item => item.productId === beverage.id)!;
      const pending = await db.payment.create({ data: { orderId: saved.id, amount: saved.total, method: "MIDTRANS_QRIS", status: "PENDING", attemptIdentifier: randomUUID() } });
      for (const operation of [{ type: "SET_CUSTOMER", customerName: "Changed" }, { type: "SET_ITEM_DETAILS", orderItemId: line.id, cups: [...cups].reverse() }]) {
        await assert.rejects(editOrder(db, cashier, { orderId: saved.id, expectedRevision: saved.revision, operation }), { code: "PAYMENT_BLOCKED" });
      }
      assert.equal((await db.order.findUniqueOrThrow({ where: { id: saved.id } })).revision, saved.revision);
      await db.payment.update({ where: { id: pending.id }, data: { status: "FAILED" } });
    });

    await t.test("database constraints reject malformed cup snapshots and customer fields", async () => {
      await assert.rejects(db.order.update({ where: { id: customized.id }, data: { customerName: "a".repeat(129) } }));
      await assert.rejects(db.orderItem.update({ where: { id: beverageLine.id }, data: { cupCustomizations: [cups[0]] } }));
      await assert.rejects(db.orderItem.update({ where: { id: beverageLine.id }, data: { cupCustomizations: [{ ...cups[0], ice: "EXTRA" }, cups[1]] } }));
      await assert.rejects(db.orderItem.update({ where: { id: beverageLine.id }, data: { cupCustomizations: [{ ...cups[0], unexpected: true }, cups[1]] } }));
      assert.deepEqual((await db.orderItem.findUniqueOrThrow({ where: { id: beverageLine.id } })).cupCustomizations, cups);
    });

    await t.test("cancelled snapshots retain metadata and reject later changes", async () => {
      const saved = await createOrder(db, cashier, { ...customInput, createIdempotencyKey: randomUUID() });
      const line = saved.items.find(item => item.productId === beverage.id)!;
      const cancelled = await cancelOrder(db, cashier, { orderId: saved.id, expectedRevision: saved.revision });
      assert.equal(cancelled.customerName, "Dina");
      assert.deepEqual(cancelled.items.find(item => item.id === line.id)!.cups, cups);
      await assert.rejects(editOrder(db, cashier, { orderId: saved.id, expectedRevision: cancelled.revision, operation: { type: "SET_CUSTOMER", customerName: "Changed" } }), { code: "ORDER_NOT_EDITABLE" });
      await assert.rejects(db.order.update({ where: { id: saved.id }, data: { customerName: "Changed" } }));
      await assert.rejects(db.orderItem.update({ where: { id: line.id }, data: { cupCustomizations: [...cups].reverse() } }));
      await assert.rejects(db.orderItem.update({ where: { id: line.id }, data: { notes: "Changed" } }));
      assert.equal((await db.ingredient.findUniqueOrThrow({ where: { id: ingredientId } })).currentStock.toFixed(), "1000");
    });

    await t.test("only authorized paid-order reads reach output renderers", async () => {
      await assert.rejects(getReceipt(db, cashier, customized.id), { code: "ORDER_NOT_FOUND" });
      for (const actor of [stock, finance, other]) await assert.rejects(getReceipt(db, actor, customized.id), { code: "FORBIDDEN" });
      for (const actor of [stock, finance, other]) await assert.rejects(editOrder(db, actor, { orderId: customized.id, expectedRevision: customized.revision, operation: { type: "SET_CUSTOMER", customerName: "Forbidden" } }), { code: "FORBIDDEN" });
    });

    const paymentInput = { orderId: customized.id, expectedRevision: customized.revision, attemptIdentifier: randomUUID(), method: "CASH", cashReceived: 50000 };
    const payment = await recordManualPayment(db, cashier, paymentInput);
    const receipt = await getReceipt(db, cashier, customized.id);
    const labels = formatCupLabels(receipt);
    await t.test("paid receipt and multi-cup labels preserve different units and exclude food", async () => {
      assert.equal(receipt.total, 49000);
      assert.equal(receipt.customerName, "Dina");
      assert.deepEqual(receipt.items.find(item => item.name === "Saved Latte")!.cups, cups);
      assert.equal(labels.length, 2);
      assert.deepEqual(labels.map(label => [label.cupNumber, label.totalCups]), [[1, 2], [2, 2]]);
      assert.match(labels[0].text, /AROOM Coffee Bar/);
      assert.match(labels[0].text, /Dina/);
      assert.match(labels[0].text, /Saved Latte/);
      assert.match(labels[1].text, /NO SUGAR/);
      assert.match(labels[1].text, /LARGE/);
      assert.match(labels[1].text, /Extra hot request/);
      assert.ok(labels.every(label => !label.text.includes("Saved Pastry")));
      assert.match(formatReceipt(receipt).text, /Dina/);
      assert.match(formatReceipt(receipt).text, /TOTAL: Rp49\.000/);
      assert.equal((await db.ingredient.findUniqueOrThrow({ where: { id: ingredientId } })).currentStock.toFixed(), "750");
      const movement = await db.stockMovement.findFirstOrThrow({ where: { paymentId: payment.id, ingredientId } });
      assert.equal(movement.quantity.toFixed(), "250", "Custom options do not alter original recipe consumption");
    });

    await t.test("receipt failure, per-cup retry, simulation and copies never mutate financial or stock records", async () => {
      const initial = await snapshot();
      assert.equal((await createReceiptPrintJob(receipt).print()).status, "failed");
      const receiptJob = createReceiptPrintJob(receipt, createSimulatedReceiptAdapter([() => { throw new Error("private transport failure"); }]));
      assert.equal((await receiptJob.print()).status, "failed");
      assert.equal((await receiptJob.print()).status, "simulated");
      assert.equal((await receiptJob.print()).status, "simulated");
      let firstAttempts = 0, secondAttempts = 0;
      const first = createCupLabelPrintJob(labels[0], createSimulatedLabelAdapter([() => { firstAttempts++; }]));
      const second = createCupLabelPrintJob(labels[1], createSimulatedLabelAdapter([() => { secondAttempts++; throw new Error("sticker disconnected"); }, () => { secondAttempts++; }]));
      assert.equal((await first.print()).status, "simulated");
      assert.equal((await second.print()).status, "failed");
      assert.equal((await second.print()).status, "simulated");
      assert.equal((await first.print()).status, "simulated");
      assert.equal(firstAttempts, 1);
      assert.equal(secondAttempts, 2);
      assert.match(formatReceipt(receipt, true).text, /\bCOPY\b/);
      const copies = formatCupLabels(await getReceipt(db, admin, customized.id), true);
      assert.equal(copies.length, 2);
      assert.ok(copies.every(label => /\bCOPY\b/.test(label.text)));
      assert.equal((await createReceiptPrintJob(receipt, createSimulatedReceiptAdapter(), true).print()).status, "simulated");
      for (const copy of copies) assert.equal((await createCupLabelPrintJob(copy, createSimulatedLabelAdapter()).print()).status, "simulated");
      assert.deepEqual(await snapshot(), initial);
      assert.deepEqual(await recordManualPayment(db, cashier, paymentInput), { ...payment, replayed: true });
      assert.deepEqual(await snapshot(), initial, "Payment retry and print retries consume no further stock");
    });

    await t.test("paid application and database metadata edits are rejected", async () => {
      const initial = await snapshot();
      const revision = (await db.order.findUniqueOrThrow({ where: { id: customized.id } })).revision;
      for (const operation of [{ type: "SET_CUSTOMER", customerName: "Changed" }, { type: "SET_ITEM_DETAILS", orderItemId: beverageLine.id, cups: [...cups].reverse() }]) {
        await assert.rejects(editOrder(db, cashier, { orderId: customized.id, expectedRevision: revision, operation }), { code: "ORDER_NOT_EDITABLE" });
      }
      await assert.rejects(db.order.update({ where: { id: customized.id }, data: { customerName: "Changed" } }));
      await assert.rejects(db.orderItem.update({ where: { id: beverageLine.id }, data: { cupCustomizations: [...cups].reverse() } }));
      await assert.rejects(db.orderItem.update({ where: { id: beverageLine.id }, data: { notes: "Changed" } }));
      assert.deepEqual(await snapshot(), initial);
    });

    await t.test("historical receipt and labels survive menu renames and closed shifts", async () => {
      await db.product.update({ where: { id: beverage.id }, data: { name: "New menu latte", price: 99000, active: false } });
      await db.shift.update({ where: { id: shiftId }, data: { status: "CLOSED", closedAt: new Date() } });
      const initial = await snapshot();
      const historical = await getReceipt(db, cashier, customized.id);
      assert.deepEqual(historical, receipt);
      assert.deepEqual(formatCupLabels(historical), labels);
      assert.equal(historical.items.find(item => item.name === "Saved Latte")!.unitPrice, 22000);
      const replay = await createOrder(db, cashier, customInput);
      assert.equal(replay.id, customized.id);
      assert.equal(replay.replayed, true);
      assert.equal(replay.status, "PAID");
      assert.equal(replay.customerName, "Dina");
      assert.deepEqual(replay.items.find(item => item.productId === beverage.id)!.cups, cups);
      assert.deepEqual(await snapshot(), initial);
    });
  } finally {
    if (before) {
      // Both connection URL and actual identity were verified disposable before
      // fixture creation. Immutable evidence cleanup is confined to our actors.
      await db.$transaction(async tx => {
        await tx.$executeRawUnsafe('ALTER TABLE "StockMovement" DISABLE TRIGGER "StockMovement_immutable"');
        await tx.stockMovement.deleteMany({ where: { actorId: { in: ids } } });
        await tx.$executeRawUnsafe('ALTER TABLE "StockMovement" ENABLE TRIGGER "StockMovement_immutable"');
        await tx.auditLog.deleteMany({ where: { actorId: { in: ids } } });
        await tx.payment.deleteMany({ where: { order: { cashierId: { in: ids } } } });
        await tx.orderItem.deleteMany({ where: { order: { cashierId: { in: ids } } } });
        await tx.order.deleteMany({ where: { cashierId: { in: ids } } });
        await tx.shift.deleteMany({ where: { id: shiftId } });
        await tx.recipeItem.deleteMany({ where: { recipe: { product: { categoryId } } } });
        await tx.recipe.deleteMany({ where: { product: { categoryId } } });
        await tx.product.deleteMany({ where: { categoryId } });
        await tx.category.deleteMany({ where: { id: categoryId } });
        await tx.ingredient.deleteMany({ where: { id: ingredientId } });
        await tx.user.deleteMany({ where: { id: { in: ids } } });
      });
      try { assert.deepEqual(await snapshot(), before, "Unrelated rows were preserved exactly"); } finally { await db.$disconnect(); }
    } else await db.$disconnect();
  }
});
