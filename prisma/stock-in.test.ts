import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient, type Prisma } from "../src/generated/prisma/client";
import { createStockIn, createSupplier, getStockIn, listIngredients, listStockIns, listSuppliers, updateSupplier } from "../src/lib/inventory/service";

test("Stock In PostgreSQL transactions, supplier management and shared balances", async t => {
  assert.notEqual(process.env.NODE_ENV, "production");
  assert.ok(process.env.DATABASE_URL);
  const url = new URL(process.env.DATABASE_URL);
  assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(url.hostname));
  assert.match(url.pathname, /^\/aroom_access_test_/, "Use the disposable database runner");
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: url.toString() }) });
  // Append-only history is intentionally retained until the runner drops this DB.
  try {
    const admin = await db.user.create({ data: { name: "Receiving admin", loginIdentifier: randomUUID(), passwordHash: "unused", role: "ADMIN" } });
    const manager = await db.user.create({ data: { name: "Stock manager", loginIdentifier: randomUUID(), passwordHash: "unused", role: "STOCK_MANAGEMENT" } });
    const supplier = await createSupplier(db, manager, { name: " Greenfields ", phone: " +62 123 " });
    const oat = await db.ingredient.create({ data: { name: `Oatmilk ${randomUUID()}`, baseUnit: "ml" } });
    const beans = await db.ingredient.create({ data: { name: `Beans ${randomUUID()}`, baseUnit: "g" } });
    const cup = await db.ingredient.create({ data: { name: `Cups ${randomUUID()}`, baseUnit: "pcs" } });
    const payload = () => ({ idempotencyKey: randomUUID(), supplierId: supplier.id, receivedAt: "2026-09-18T09:00:00+07:00", notes: "Morning delivery",
      items: [{ ingredientId: oat.id, quantity: "12", unit: "L", unitCost: 20 },
        { ingredientId: beans.id, quantity: "1", unit: "kg", unitCost: 100 },
        { ingredientId: cup.id, quantity: "1000", unit: "pcs", unitCost: 200 }] });
    const stock = async (id: string) => (await db.ingredient.findUniqueOrThrow({ where: { id } })).currentStock.toFixed();
    const counts = async () => ({ receipts: await db.stockIn.count(), lines: await db.stockInItem.count(), movements: await db.stockMovement.count(),
      stock: await Promise.all([oat.id, beans.id, cup.id].map(stock)) });
    let receiptId = "";
    const originalRequest = payload();

    await t.test("three recipes retain one oatmilk balance after multi-item receipt", async () => {
      const category = await db.category.create({ data: { name: "Receiving fixture" } });
      for (const [name, quantity] of [["Single", 100], ["Double", 150], ["Matcha", 120]] as const) {
        await db.product.create({ data: { categoryId: category.id, name, price: 22000,
          recipe: { create: { items: { create: { ingredientId: oat.id, quantity, unit: "ml" } } } } } });
      }
      const request = originalRequest;
      const receipt = await createStockIn(db, manager, request); receiptId = receipt.id;
      assert.equal(receipt.replayed, false); assert.equal(receipt.actorId, manager.id);
      assert.equal(receipt.receivedAt, "2026-09-18T02:00:00.000Z"); assert.equal(receipt.supplierName, "Greenfields");
      assert.equal(receipt.items.find(item => item.ingredientId === oat.id)?.lineTotal, 240000);
      assert.deepEqual(await Promise.all([oat.id, beans.id, cup.id].map(stock)), ["12000", "1000", "1000"]);
      const recipes = await db.recipeItem.findMany({ where: { ingredientId: oat.id }, include: { recipe: { include: { product: true } } } });
      assert.deepEqual(recipes.map(item => item.quantity.toNumber()).sort((a, b) => a - b), [100, 120, 150]);
      assert.ok(recipes.every(item => item.recipe.product.price === 22000 && item.recipe.product.available));
      assert.equal((await db.ingredient.findUniqueOrThrow({ where: { id: oat.id } })).unitCost, null);
      const movements = await db.stockMovement.findMany({ where: { sourceType: "StockIn", sourceId: receipt.id } });
      assert.equal(movements.length, 3);
      for (const movement of movements) {
        const line = receipt.items.find(item => item.ingredientId === movement.ingredientId)!;
        assert.equal(movement.quantity.toFixed(), line.baseQuantity); assert.equal(movement.unit, line.baseUnit);
        assert.equal(movement.stockAfter.toFixed(), line.baseQuantity); assert.equal(movement.type, "PURCHASE"); assert.equal(movement.actorId, manager.id);
      }
      const before = await counts();
      assert.deepEqual(await createStockIn(db, manager, request), { ...receipt, replayed: true });
      assert.deepEqual(await counts(), before);
      await assert.rejects(createStockIn(db, manager, { ...request, notes: "changed" }), { code: "IDEMPOTENCY_CONFLICT" });
      await assert.rejects(createStockIn(db, admin, request), { code: "IDEMPOTENCY_CONFLICT" });
      assert.equal((await getStockIn(db, admin, receipt.id)).id, receipt.id);
    });

    await t.test("supplier metadata edits/retirement preserve history and audit only changes", async () => {
      assert.ok((await listSuppliers(db, admin)).some(row => row.id === supplier.id));
      const update = { supplierId: supplier.id, name: "New supplier name", active: false, phone: "123" };
      await updateSupplier(db, manager, update); await updateSupplier(db, manager, update);
      assert.equal(await db.auditLog.count({ where: { entityId: supplier.id } }), 2);
      assert.equal((await getStockIn(db, manager, receiptId)).supplierName, "Greenfields");
      await assert.rejects(createStockIn(db, manager, payload()), { code: "SUPPLIER_INACTIVE" });
      assert.equal((await createStockIn(db, manager, originalRequest)).replayed, true);
      await updateSupplier(db, admin, { ...update, active: true });
      await assert.rejects(updateSupplier(db, admin, { ...update, supplierId: randomUUID() }), { code: "SUPPLIER_NOT_FOUND" });
    });

    await t.test("invalid references, units and quantities leave no partial state", async () => {
      const before = await counts();
      for (const [change, code] of [
        [{ supplierId: randomUUID() }, "SUPPLIER_NOT_FOUND"],
        [{ items: [...payload().items, { ingredientId: randomUUID(), quantity: "1", unit: "pcs", unitCost: 0 }] }, "INGREDIENT_NOT_FOUND"],
        [{ items: [{ ...payload().items[0], unit: "kg" }] }, "INCOMPATIBLE_UNIT"],
        [{ items: [{ ...payload().items[0], quantity: "999999999999999" }] }, "INVALID_QUANTITY"],
        [{ items: [{ ...payload().items[0], quantity: "0.001", unit: "ml" }] }, "INVALID_COST"],
      ] as const) await assert.rejects(createStockIn(db, manager, { ...payload(), ...change }), { code });
      await db.ingredient.update({ where: { id: oat.id }, data: { active: false } });
      await assert.rejects(createStockIn(db, manager, payload()), { code: "INGREDIENT_INACTIVE" });
      assert.equal((await createStockIn(db, manager, originalRequest)).replayed, true);
      await db.ingredient.update({ where: { id: oat.id }, data: { active: true } });
      assert.deepEqual(await counts(), before);
      const full = await db.ingredient.create({ data: { name: randomUUID(), baseUnit: "pcs", currentStock: "999999999999999.999" } });
      await assert.rejects(createStockIn(db, manager, { ...payload(), items: [{ ingredientId: full.id, quantity: "0.001", unit: "pcs", unitCost: 0 }] }), { code: "INVALID_QUANTITY" });
      assert.equal(await stock(full.id), "999999999999999.999"); assert.deepEqual(await counts(), before);
    });

    await t.test("failure after writes rolls back header, lines, movements and balances; same key recovers", async () => {
      for (const failedModel of ["stockMovement", "ingredient"] as const) {
        let writes = 0;
        const broken = { $transaction: (fn: (tx: Prisma.TransactionClient) => Promise<unknown>) => db.$transaction(tx => fn(new Proxy(tx, {
          get(target, key) {
            if (key !== failedModel) return Reflect.get(target, key);
            return new Proxy(target[failedModel], { get(model, method) {
              const original = Reflect.get(model, method);
              if (method !== (failedModel === "ingredient" ? "update" : "create")) return original;
              return async (...args: unknown[]) => { if (++writes === 2) throw new Error("injected write failure"); return original.apply(model, args); };
            } });
          },
        }))) } as unknown as PrismaClient;
        const request = payload(), before = await counts();
        await assert.rejects(createStockIn(broken, manager, request), /injected write failure/);
        assert.equal(writes, 2); assert.deepEqual(await counts(), before);
        assert.equal(await db.stockIn.count({ where: { idempotencyKey: request.idempotencyKey } }), 0);
        assert.equal((await createStockIn(db, manager, request)).replayed, false);
      }
    });

    await t.test("supplier audit failure rolls back both creation and metadata updates", async () => {
      const broken = { $transaction: (fn: (tx: Prisma.TransactionClient) => Promise<unknown>) => db.$transaction(tx => fn(new Proxy(tx, {
        get(target, key) { return key === "auditLog" ? { create: async () => { throw new Error("audit unavailable"); } } : Reflect.get(target, key); },
      }))) } as unknown as PrismaClient;
      const before = await db.supplier.findUniqueOrThrow({ where: { id: supplier.id } });
      await assert.rejects(updateSupplier(broken, manager, { supplierId: supplier.id, name: "Rollback", active: false }), /audit unavailable/);
      assert.deepEqual(await db.supplier.findUniqueOrThrow({ where: { id: supplier.id } }), before);
      const name = randomUUID();
      await assert.rejects(createSupplier(broken, admin, { name }), /audit unavailable/);
      assert.equal(await db.supplier.count({ where: { name } }), 0);
    });

    await t.test("concurrent duplicate submissions commit once; distinct receipts add without lost updates", async () => {
      const request = payload(), before = await counts();
      const copies = await Promise.all([createStockIn(db, manager, request), createStockIn(db, manager, request)]);
      assert.equal(copies[0].id, copies[1].id); assert.equal(copies.filter(copy => copy.replayed).length, 1);
      assert.equal((await counts()).receipts, before.receipts + 1);
      assert.equal(BigInt(await stock(oat.id)), BigInt(before.stock[0]) + BigInt(12000));
      const start = await counts();
      await Promise.all([createStockIn(db, manager, payload()), createStockIn(db, admin, { ...payload(), items: payload().items.reverse() })]);
      assert.equal(BigInt(await stock(oat.id)), BigInt(start.stock[0]) + BigInt(24000));
      assert.equal((await counts()).movements, start.movements + 6);
      const movements = await db.stockMovement.findMany({ where: { ingredientId: oat.id }, orderBy: { stockAfter: "asc" } });
      assert.deepEqual(movements.map(m => m.stockAfter.toNumber()), movements.map((_, i) => (i + 1) * 12000));
    });

    await t.test("database rejects history edits/deletes and inconsistent line conversions/costs", async () => {
      const line = await db.stockInItem.findFirstOrThrow({ where: { stockInId: receiptId } });
      await assert.rejects(db.stockIn.update({ where: { id: receiptId }, data: { notes: "rewrite" } }));
      await assert.rejects(db.stockIn.delete({ where: { id: receiptId } }));
      await assert.rejects(db.stockInItem.update({ where: { id: line.id }, data: { unitCost: 0 } }));
      await assert.rejects(db.stockInItem.delete({ where: { id: line.id } }));
      await assert.rejects(db.supplier.delete({ where: { id: supplier.id } }), { code: "P2003" });
      const movement = await db.stockMovement.findFirstOrThrow({ where: { sourceId: receiptId } });
      const { id: _id, ...movementData } = movement; void _id;
      await assert.rejects(db.stockMovement.create({ data: movementData }), { code: "P2002" });
      const extra = await db.ingredient.create({ data: { name: randomUUID(), baseUnit: "ml" } });
      const data = { stockInId: receiptId, ingredientId: extra.id, ingredientNameSnapshot: extra.name, inputQuantity: 1, inputUnit: "L" as const,
        baseQuantity: 1000, baseUnit: "ml" as const, unitCost: 20, lineTotal: 20000 };
      for (const invalid of [{ baseQuantity: 1 }, { inputUnit: "kg" as const }, { lineTotal: 1 }, { unitCost: -1 }, { inputQuantity: 0 }]) {
        await assert.rejects(db.stockInItem.create({ data: { ...data, ...invalid } }));
      }
    });

    await t.test("ingredient reads expose exact shared balances and server-calculated thresholds", async () => {
      const fixtures = [];
      for (const [currentStock, minimumStock, active, expected] of [["0", "0", true, "EMPTY"], ["0.001", "0.001", true, "LOW"],
        ["0.001", "0.002", true, "LOW"], ["0.003", "0.002", true, "AVAILABLE"], ["999999999999999.999", "0", false, "AVAILABLE"]] as const) {
        const ingredient = await db.ingredient.create({ data: { name: randomUUID(), baseUnit: "g", currentStock, minimumStock, active } });
        fixtures.push({ ingredient, expected });
      }
      const rows = await listIngredients(db, manager);
      for (const { ingredient, expected } of fixtures) {
        const row = rows.find(row => row.id === ingredient.id)!;
        assert.equal(row.currentStock, ingredient.currentStock.toFixed()); assert.equal(row.minimumStock, ingredient.minimumStock.toFixed());
        assert.equal(row.stockStatus, expected); assert.equal(row.active, ingredient.active);
        assert.deepEqual(Object.keys(row).sort(), ["active", "baseUnit", "currentStock", "id", "minimumStock", "name", "stockStatus"]);
      }
      assert.equal(rows.filter(row => row.id === oat.id).length, 1);
    });

    await t.test("history pagination, safe detail and snapshots survive later metadata changes", async () => {
      const ingredient = await db.ingredient.create({ data: { name: randomUUID(), baseUnit: "pcs" } });
      const request = () => ({ ...payload(), items: [{ ingredientId: ingredient.id, quantity: "1", unit: "pcs", unitCost: 10 }] });
      for (let i = 0; i < 27; i++) await createStockIn(db, manager, request());
      const before = await counts();
      const first = await listStockIns(db, manager);
      assert.equal(first.entries.length, 25); assert.ok(first.nextCursor);
      assert.equal(first.entries[0].actorName, manager.name); assert.equal(first.entries[0].total, 10);
      const later = await createStockIn(db, manager, request());
      const second = await listStockIns(db, manager, { cursor: first.nextCursor });
      const expected = await db.stockIn.findMany({ where: { id: { not: later.id } }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], select: { id: true } });
      assert.deepEqual([...first.entries, ...second.entries].map(row => row.id), expected.map(row => row.id));
      assert.equal(second.nextCursor, null); assert.equal(new Set([...first.entries, ...second.entries].map(row => row.id)).size, expected.length);
      await db.ingredient.update({ where: { id: ingredient.id }, data: { name: "Renamed fixture", active: false } });
      const detail = await getStockIn(db, admin, later.id);
      assert.equal(detail.items[0].ingredientName, ingredient.name); assert.equal(detail.total, 10); assert.equal(detail.actorName, manager.name);
      assert.doesNotMatch(JSON.stringify([first, second, detail]), /passwordHash|requestFingerprint|idempotencyKey/);
      await assert.rejects(listStockIns(db, manager, { cursor: "bad" }), { code: "INVALID_ID" });
      await assert.rejects(listStockIns(db, manager, { actorId: manager.id }), { code: "INVALID_INPUT" });
      assert.equal((await counts()).receipts, before.receipts + 1);
    });

    await t.test("all services reject cashier/finance, missing, stale and inactive actors", async () => {
      const calls = (actor: typeof manager) => [() => listSuppliers(db, actor), () => createSupplier(db, actor, { name: "Denied" }),
        () => updateSupplier(db, actor, { supplierId: supplier.id, name: "Denied", active: true }),
        () => createStockIn(db, actor, payload()), () => getStockIn(db, actor, receiptId), () => listIngredients(db, actor), () => listStockIns(db, actor)];
      const before = await counts();
      for (const role of ["CASHIER", "FINANCE"] as const) for (const call of calls({ ...manager, role })) await assert.rejects(call(), { code: "FORBIDDEN" });
      for (const call of calls({ ...manager, id: randomUUID() })) await assert.rejects(call(), { code: "FORBIDDEN" });
      for (const data of [{ active: false }, { active: true, role: "FINANCE" as const }]) {
        await db.user.update({ where: { id: manager.id }, data });
        for (const call of calls(manager)) await assert.rejects(call(), { code: "FORBIDDEN" });
      }
      assert.deepEqual(await counts(), before);
    });
  } finally { await db.$disconnect(); }
});
