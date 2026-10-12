import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient, type Prisma } from "../src/generated/prisma/client";
import { createStockIn } from "../src/lib/inventory/service";
import { saveInventoryPurchaseOrder as save, getInventoryPurchaseOrder as get, listInventoryPurchaseOrders as list, readInventoryPurchaseOrderHistory as history } from "../src/lib/inventory-purchase-orders/service";

test("inventory PO backend is authorized, atomic, replay-safe and inventory-neutral", async t => {
  assert.notEqual(process.env.NODE_ENV, "production");
  const url = new URL(process.env.DATABASE_URL!);
  assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(url.hostname));
  assert.match(url.pathname, /^\/aroom_access_test_[a-f0-9]{32}$/);
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: url.toString() }) });
  try {
    const users = await Promise.all((["STOCK_MANAGEMENT", "FINANCE", "ADMIN", "CASHIER", "PROCUREMENT"] as const).map(role =>
      db.user.create({ data: { name: role, role, loginIdentifier: randomUUID(), passwordHash: "unused" } })));
    const [stock, finance, admin, cashier, procurement] = users;
    const supplier = await db.supplier.create({ data: { name: randomUUID() } });
    const milk = await db.ingredient.create({ data: { name: randomUUID(), baseUnit: "ml" } });
    const receipt = await createStockIn(db, stock, { idempotencyKey: randomUUID(), supplierId: supplier.id,
      receivedAt: "2026-10-11T09:00:00+07:00", items: [{ ingredientId: milk.id, quantity: "1", unit: "L", purchaseUnitCost: 33333 }] });
    const inventory = async () => ({ ingredients: await db.ingredient.findMany({ orderBy: { id: "asc" } }),
      stockIns: await db.stockIn.findMany({ orderBy: { id: "asc" } }), items: await db.stockInItem.findMany({ orderBy: { id: "asc" } }),
      movements: await db.stockMovement.findMany({ orderBy: { id: "asc" } }), recipes: await db.recipe.findMany({ orderBy: { id: "asc" } }),
      recipeItems: await db.recipeItem.findMany({ orderBy: { id: "asc" } }), expenses: await db.financeExpense.count() });
    const baseline = await inventory();
    const draft = () => ({ id: randomUUID(), key: randomUUID(), operation: "CREATE", revision: 0, data: {
      supplierId: supplier.id, notes: "Purchase ingredients", lines: [
        { id: randomUUID(), ingredientId: milk.id, purchaseQuantity: "6", purchaseUnit: "L", estimatedUnitPrice: 33333 },
        { id: randomUUID(), proposedIngredient: { name: randomUUID(), baseUnit: "g" }, purchaseQuantity: "0.5", purchaseUnit: "kg", estimatedUnitPrice: 100000 },
      ],
    } });
    const command = (id: string, revision: number, operation: string) => ({ id, revision, operation, key: randomUUID() });
    let approvedId = "";
    const createRequest = draft();
    await t.test("concurrent creation replays once; draft edit freezes estimates through approval and ordering", async () => {
      const request = createRequest;
      const results = await Promise.all([save(db, stock, request), save(db, stock, request)]);
      assert.deepEqual(results[0], results[1]); approvedId = request.id;
      let po = await get(db, admin, { id: request.id });
      assert.match(po.referenceNumber, /^IPO-\d{8}-/); const reference = po.referenceNumber;
      assert.equal(po.estimatedTotal, 249998); assert.equal(po.lines[0].baseQuantity, "6000");
      assert.equal(po.lines[1].baseQuantity, "500"); assert.equal(po.lines[1].ingredientId, null);
      const edit = { ...request, key: randomUUID(), revision: 1, operation: "EDIT", data: { ...request.data, notes: "Edited" } };
      await save(db, stock, edit);
      await assert.rejects(save(db, stock, { ...edit, key: randomUUID() }), { code: "STALE_REVISION" });
      await save(db, stock, command(request.id, 2, "SUBMIT"));
      await assert.rejects(save(db, stock, { ...edit, key: randomUUID(), revision: 3 }), { code: "INVALID_TRANSITION" });
      await save(db, finance, command(request.id, 3, "APPROVE"));
      await save(db, stock, command(request.id, 4, "ORDER"));
      po = await get(db, finance, { id: request.id });
      assert.equal(po.status, "ORDERED"); assert.equal(po.decidedBy, finance.id); assert.equal(po.referenceNumber, reference);
      assert.equal(po.estimatedTotal, 249998);
      assert.deepEqual(await save(db, stock, request), { id: request.id, revision: 1 });
      assert.equal((await get(db, stock, { id: request.id })).revision, 5);
      assert.equal((await history(db, admin, { id: request.id })).rows.length, 5);
      assert.equal(await db.auditLog.count({ where: { entityType: "InventoryPurchaseOrder", entityId: request.id } }), 5);
      await assert.rejects(save(db, stock, { ...request, data: { ...request.data, notes: "Different intent" } }), { code: "IDEMPOTENCY_CONFLICT" });
      assert.deepEqual(await inventory(), baseline);
    });
    await t.test("only Finance decides; Admin is read-only; inactive and forged identities are denied", async () => {
      for (const user of [admin, finance, cashier, procurement]) await assert.rejects(save(db, user, draft()), { code: "FORBIDDEN" });
      for (const user of [cashier, procurement]) {
        await assert.rejects(list(db, user), { code: "FORBIDDEN" });
        await assert.rejects(get(db, user, { id: approvedId }), { code: "FORBIDDEN" });
        await assert.rejects(history(db, user, { id: approvedId }), { code: "FORBIDDEN" });
      }
      const request = draft(); await save(db, stock, request); await save(db, stock, command(request.id, 1, "SUBMIT"));
      for (const user of [admin, stock, cashier, procurement]) for (const operation of ["APPROVE", "REJECT"]) {
        await assert.rejects(save(db, user, { ...command(request.id, 2, operation), note: "Reason" }), { code: "FORBIDDEN" });
      }
      await assert.rejects(save(db, { ...cashier, role: "FINANCE" }, command(request.id, 2, "APPROVE")), { code: "FORBIDDEN" });
      await db.user.update({ where: { id: stock.id }, data: { role: "FINANCE" } });
      await assert.rejects(save(db, stock, command(request.id, 2, "APPROVE")), { code: "FORBIDDEN" });
      await assert.rejects(save(db, stock, { ...command(request.id, 2, "REJECT"), note: "Own PO" }), { code: "FORBIDDEN" });
      await db.user.update({ where: { id: stock.id }, data: { role: "STOCK_MANAGEMENT", active: false } });
      await assert.rejects(save(db, stock, createRequest), { code: "FORBIDDEN" });
      await assert.rejects(list(db, stock), { code: "FORBIDDEN" });
      await db.user.update({ where: { id: stock.id }, data: { active: true } });
      await save(db, finance, { ...command(request.id, 2, "REJECT"), note: "Not needed" });
      assert.equal((await get(db, admin, { id: request.id })).status, "REJECTED");
      await assert.rejects(save(db, stock, command(request.id, 3, "SUBMIT")), { code: "INVALID_TRANSITION" });
    });
    await t.test("concurrent edit/submit and approve/reject serialize with one winning revision", async () => {
      const request = draft(); await save(db, stock, request);
      const race = await Promise.allSettled([save(db, stock, { ...request, key: randomUUID(), operation: "EDIT", revision: 1 }), save(db, stock, command(request.id, 1, "SUBMIT"))]);
      assert.equal(race.filter(r => r.status === "fulfilled").length, 1);
      assert.equal(race.filter(r => r.status === "rejected").length, 1);
      let po = await get(db, stock, { id: request.id });
      if (po.status === "DRAFT") { await save(db, stock, command(po.id, po.revision, "SUBMIT")); po = await get(db, stock, { id: po.id }); }
      const decisions = await Promise.allSettled([save(db, finance, command(po.id, po.revision, "APPROVE")), save(db, finance, { ...command(po.id, po.revision, "REJECT"), note: "No" })]);
      assert.equal(decisions.filter(r => r.status === "fulfilled").length, 1);
      assert.equal(decisions.filter(r => r.status === "rejected").length, 1);
    });
    await t.test("supplier/ingredient validation and failed nested writes roll back the whole operation", async () => {
      const count = await db.inventoryPurchaseOrder.count();
      const request = draft();
      await assert.rejects(save(db, stock, { ...request, data: { ...request.data, supplierId: randomUUID() } }), { code: "SUPPLIER_UNAVAILABLE" });
      await db.supplier.update({ where: { id: supplier.id }, data: { active: false } });
      await assert.rejects(save(db, stock, request), { code: "SUPPLIER_UNAVAILABLE" });
      assert.deepEqual(await save(db, stock, createRequest), { id: createRequest.id, revision: 1 });
      await db.supplier.update({ where: { id: supplier.id }, data: { active: true } });
      await db.ingredient.update({ where: { id: milk.id }, data: { active: false } });
      await assert.rejects(save(db, stock, request), { code: "INGREDIENT_UNAVAILABLE" });
      await db.ingredient.update({ where: { id: milk.id }, data: { active: true } });
      const proposed = { ...request.data.lines[1], purchaseUnit: "L", proposedIngredient: { name: ` ${milk.name.toUpperCase()} `, baseUnit: "ml" } };
      await assert.rejects(save(db, stock, { ...request, data: { ...request.data, lines: [proposed] } }), { code: "DUPLICATE_INGREDIENT" });
      assert.equal(await db.inventoryPurchaseOrder.count(), count);
      // Use an existing line primary key on another draft to force a DB failure
      // after the header INSERT. No event/header/partial lines may survive.
      const conflict = { ...request, data: { ...request.data, lines: [{ ...request.data.lines[0], id: createRequest.data.lines[0].id }] } };
      await assert.rejects(save(db, stock, conflict), { code: "INVALID_INPUT" });
      assert.equal(await db.inventoryPurchaseOrder.count(), count);
      assert.equal(await db.inventoryPurchaseOrderEvent.count({ where: { key: request.key } }), 0);
      await save(db, stock, request); // Same key remains usable after rollback.
    });
    await t.test("history, audit, submitted lines and manual receipts remain immutable", async () => {
      await assert.rejects(db.inventoryPurchaseOrderEvent.update({ where: { key: createRequest.key }, data: { note: "tamper" } }), /immutable/);
      await assert.rejects(db.inventoryPurchaseOrderEvent.delete({ where: { key: createRequest.key } }), /immutable/);
      await assert.rejects(db.auditLog.updateMany({ where: { entityType: "InventoryPurchaseOrder", entityId: approvedId }, data: { action: "tamper" } }), /immutable/);
      await assert.rejects(db.inventoryPurchaseOrderLine.update({ where: { id: createRequest.data.lines[0].id }, data: { estimatedUnitPrice: 1 } }), /frozen/);
      await assert.rejects(db.inventoryPurchaseOrder.delete({ where: { id: approvedId } }), /prohibited/);
      await assert.rejects(db.stockIn.update({ where: { id: receipt.id }, data: { purchaseOrderId: approvedId } }), /immutable/);
      await assert.rejects(db.stockInItem.update({ where: { id: receipt.items[0].id }, data: { purchaseOrderLineId: createRequest.data.lines[0].id } }), /immutable/);
      const row = await db.stockIn.findUniqueOrThrow({ where: { id: receipt.id }, include: { items: true } });
      assert.equal(row.purchaseOrderId, null); assert.equal(row.items[0].purchaseOrderLineId, null);
      for (const operation of ["RECEIVE", "CANCEL"]) await assert.rejects(save(db, stock, command(approvedId, 5, operation)), { code: "INVALID_INPUT" });
    });
    await t.test("audit failure rolls back edited terms, revision and event; retry succeeds", async () => {
      const request = draft(); await save(db, stock, request);
      const before = await get(db, admin, { id: request.id });
      const broken = new Proxy(db, { get(target, key) {
        if (key !== "$transaction") return Reflect.get(target, key);
        return (work: (tx: Prisma.TransactionClient) => Promise<unknown>) => db.$transaction(tx => work(new Proxy(tx, { get(client, field) {
          if (field === "auditLog") return { create: async () => { throw new Error("injected audit failure"); } };
          return Reflect.get(client, field);
        } })));
      } });
      const edit = { ...request, key: randomUUID(), operation: "EDIT", revision: 1, data: { ...request.data, notes: "Atomic edit" } };
      await assert.rejects(save(broken, stock, edit), /injected audit failure/);
      assert.deepEqual(await get(db, admin, { id: request.id }), before);
      assert.equal(await db.inventoryPurchaseOrderEvent.count({ where: { key: edit.key } }), 0);
      await save(db, stock, edit);
      assert.equal((await get(db, admin, { id: request.id })).revision, 2);
    });
    await t.test("SQL protects totals, exact conversions, identity and deferred transitions", async () => {
      const request = draft(); await save(db, stock, request);
      await assert.rejects(db.inventoryPurchaseOrder.update({ where: { id: request.id }, data: { revision: 2, estimatedTotal: 1 } }), /total/);
      await assert.rejects(db.inventoryPurchaseOrderLine.update({ where: { id: request.data.lines[0].id }, data: { baseQuantity: 6 } }), /check constraint/);
      await assert.rejects(db.inventoryPurchaseOrder.update({ where: { id: request.id }, data: { revision: 2, createdBy: finance.id } }), /identity/);
      await assert.rejects(db.inventoryPurchaseOrder.update({ where: { id: approvedId }, data: { revision: 6, status: "RECEIVED" } }), /transition/);
      await assert.rejects(db.inventoryPurchaseOrder.update({ where: { id: request.id }, data: { revision: 2, status: "CANCELLED" } }), /transition/);
      await assert.rejects(db.stockIn.create({ data: { referenceNumber: randomUUID(), idempotencyKey: randomUUID(), requestFingerprint: "test",
        supplierId: supplier.id, supplierNameSnapshot: supplier.name, actorId: stock.id, receivedAt: new Date(), purchaseOrderId: randomUUID() } }), /supplier mismatch|foreign key/i);
      await assert.rejects(db.stockIn.create({ data: { referenceNumber: randomUUID(), idempotencyKey: randomUUID(), requestFingerprint: "test",
        supplierId: supplier.id, supplierNameSnapshot: supplier.name, actorId: stock.id, receivedAt: new Date(), purchaseOrderId: request.id } }), /requires ordered terms/);
    });
    await t.test("list filters and history return saved evidence without exposing credentials", async () => {
      for (const user of [stock, finance, admin]) {
        const rows = await list(db, user, { status: "ORDERED", supplierId: supplier.id });
        assert.ok(rows.rows.some(r => r.id === approvedId));
        assert.equal(rows.hasMore, false);
        assert.equal(JSON.stringify(rows).includes("passwordHash"), false);
      }
      assert.equal((await list(db, finance, { page: 2, supplierId: supplier.id })).rows.length, 0);
      assert.equal((await list(db, admin, { search: (await get(db, admin, { id: approvedId })).referenceNumber })).rows.length, 1);
      await assert.rejects(list(db, admin, { page: -1 }), { code: "INVALID_INPUT" });
      await assert.rejects(get(db, admin, { id: randomUUID() }), { code: "NOT_FOUND" });
      const evidence = await history(db, finance, { id: approvedId });
      assert.deepEqual(evidence.rows.map(e => e.operation), ["CREATE", "EDIT", "SUBMIT", "APPROVE", "ORDER"]);
      assert.equal(evidence.rows[3].actorId, finance.id);
    });
    // Only test-fixture eligibility toggles changed updatedAt on the ingredient.
    const after = await inventory();
    assert.deepEqual(after.ingredients.map(row => ({ ...row, updatedAt: null })), baseline.ingredients.map(row => ({ ...row, updatedAt: null })));
    assert.deepEqual({ ...after, ingredients: [] }, { ...baseline, ingredients: [] });
  } finally { await db.$disconnect(); }
});
