import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient, type Prisma } from "../src/generated/prisma/client";
import { categoryHistory, listCategories, saveCategory } from "../src/lib/categories/service";
import { createMenu, listRecipeOptions } from "../src/lib/inventory/recipe-service";

test("category management on an isolated PostgreSQL database", async t => {
  assert.notEqual(process.env.NODE_ENV, "production");
  const url = new URL(process.env.DATABASE_URL!);
  assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)); assert.match(url.pathname, /^\/aroom_access_test_[a-f0-9]{32}$/);
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: url.toString() }) });
  const request = () => ({ key: randomUUID(), id: null, expectedRevision: null, name: randomUUID(), displayOrder: 0, active: true });
  try {
    const admin = await db.user.create({ data: { name: "Category admin", loginIdentifier: randomUUID(), passwordHash: "unused", role: "ADMIN" } });
    const second = await db.user.create({ data: { name: "Other admin", loginIdentifier: randomUUID(), passwordHash: "unused", role: "ADMIN" } });
    await t.test("all non-admin roles, forged roles and revoked users are denied", async () => {
      for (const role of ["CASHIER", "FINANCE", "STOCK_MANAGEMENT", "PROCUREMENT"] as const) {
        const user = await db.user.create({ data: { name: role, role, loginIdentifier: randomUUID(), passwordHash: "unused" } });
        for (const actor of [user, { ...user, role: "ADMIN" }]) {
          await assert.rejects(listCategories(db, actor), { code: "FORBIDDEN" });
          await assert.rejects(saveCategory(db, actor, request()), { code: "FORBIDDEN" });
          await assert.rejects(categoryHistory(db, actor, randomUUID()), { code: "FORBIDDEN" });
        }
      }
      await db.user.update({ where: { id: second.id }, data: { active: false } });
      await assert.rejects(saveCategory(db, second, request()), { code: "FORBIDDEN" });
      await db.user.update({ where: { id: second.id }, data: { active: true } });
    });
    const original = request();
    const created = await saveCategory(db, admin, original);
    await t.test("creation, exact concurrent replay, actor binding and changed intent", async () => {
      const copies = await Promise.all([saveCategory(db, admin, original), saveCategory(db, admin, original)]);
      assert.ok(copies.every(copy => copy.replayed && copy.category.id === created.category.id));
      assert.equal(await db.auditLog.count({ where: { id: original.key } }), 1);
      await assert.rejects(saveCategory(db, second, original), { code: "IDEMPOTENCY_CONFLICT" });
      await assert.rejects(saveCategory(db, admin, { ...original, name: "changed" }), { code: "IDEMPOTENCY_CONFLICT" });
    });
    await t.test("rename, ordering, activation and stale revisions preserve retry history", async () => {
      const edit = { ...original, key: randomUUID(), id: created.category.id, expectedRevision: 1, name: `Renamed ${randomUUID()}`, displayOrder: 5, active: false };
      const updated = await saveCategory(db, admin, edit);
      assert.equal(updated.category.revision, 2); assert.equal(updated.category.active, false);
      await assert.rejects(saveCategory(db, admin, { ...edit, key: randomUUID() }), { code: "STALE_REVISION" });
      assert.deepEqual(await saveCategory(db, admin, original), { ...created, replayed: true });
      assert.deepEqual(await db.category.findUniqueOrThrow({ where: { id: edit.id } }), updated.category);
      await assert.rejects(saveCategory(db, admin, { ...request(), name: ` ${edit.name.toUpperCase()} ` }), { code: "DUPLICATE_NAME" });
      await assert.rejects(db.category.create({ data: { name: ` ${edit.name.toUpperCase()} ` } }), { code: "P2002" });
      const enabled = await saveCategory(db, admin, { ...edit, key: randomUUID(), expectedRevision: 2, active: true });
      assert.equal(enabled.category.revision, 3);
      const events = await categoryHistory(db, admin, edit.id); assert.equal(events.length, 3);
      assert.ok(events.every(e => e.actorId === admin.id));
      await assert.rejects(db.auditLog.update({ where: { id: original.key }, data: { action: "tampered" } }));
      await assert.rejects(db.auditLog.delete({ where: { id: original.key } }));
      assert.ok((await listCategories(db, admin)).some(row => row.id === edit.id && row.displayOrder === 5));
    });
    await t.test("concurrent new names and competing revisions commit only once", async () => {
      const a = request(), b = { ...a, key: randomUUID(), name: a.name.toUpperCase() };
      const results = await Promise.allSettled([saveCategory(db, admin, a), saveCategory(db, second, b)]);
      assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
      assert.equal((results.find(r => r.status === "rejected") as PromiseRejectedResult).reason.code, "DUPLICATE_NAME");
      const row = (await saveCategory(db, admin, request())).category;
      const update = { ...request(), id: row.id, expectedRevision: row.revision };
      const edits = await Promise.allSettled([saveCategory(db, admin, update), saveCategory(db, second, { ...update, key: randomUUID() })]);
      assert.equal(edits.filter(r => r.status === "fulfilled").length, 1);
      assert.equal((edits.find(r => r.status === "rejected") as PromiseRejectedResult).reason.code, "STALE_REVISION");
    });
    await t.test("audit write failure rolls back category and same intent can recover", async () => {
      const broken = { $transaction: (fn: (tx: Prisma.TransactionClient) => Promise<unknown>) => db.$transaction(tx => fn(new Proxy(tx, {
        get(target, key) { if (key !== "auditLog") return Reflect.get(target, key); return new Proxy(target.auditLog, { get(model, method) {
          return method === "create" ? async () => { throw new Error("audit failure"); } : Reflect.get(model, method);
        } }); },
      }))) } as unknown as PrismaClient;
      const input = request(); await assert.rejects(saveCategory(broken, admin, input), /audit failure/);
      assert.equal(await db.category.count({ where: { name: input.name } }), 0);
      assert.equal((await saveCategory(db, admin, input)).replayed, false);
    });
    await t.test("no-op saves preserve revision with explicit durable retry evidence", async () => {
      const row = (await saveCategory(db, admin, request())).category;
      const input = { key: randomUUID(), id: row.id, expectedRevision: row.revision, name: row.name, displayOrder: row.displayOrder, active: row.active };
      const saved = await saveCategory(db, admin, input);
      assert.deepEqual(saved.category, row);
      assert.equal((await db.auditLog.findUniqueOrThrow({ where: { id: input.key } })).action, "CATEGORY_UNCHANGED");
      assert.equal((await saveCategory(db, admin, input)).replayed, true);
    });
    await t.test("new category supports real menu creation and deactivation preserves product/recipe/stock", async () => {
      const row = (await saveCategory(db, admin, request())).category;
      const ingredient = await db.ingredient.create({ data: { name: randomUUID(), baseUnit: "g" } });
      const menu = await createMenu(db, admin, { idempotencyKey: randomUUID(), name: randomUUID(), price: 22000, categoryId: row.id,
        items: [{ ingredientId: ingredient.id, quantity: "10", unit: "g" }] });
      const product = await db.product.findUniqueOrThrow({ where: { id: menu.productId }, include: { recipe: { include: { items: true } } } });
      assert.equal(product.categoryId, row.id); assert.ok((await listRecipeOptions(db, admin)).categories.some(c => c.id === row.id));
      await saveCategory(db, admin, { key: randomUUID(), id: row.id, expectedRevision: 1, name: row.name, displayOrder: 0, active: false });
      assert.ok(!(await listRecipeOptions(db, admin)).categories.some(c => c.id === row.id));
      assert.deepEqual(await db.product.findUniqueOrThrow({ where: { id: product.id }, include: { recipe: { include: { items: true } } } }), product);
      assert.deepEqual(await db.ingredient.findUniqueOrThrow({ where: { id: ingredient.id } }), ingredient);
      await assert.rejects(db.category.delete({ where: { id: row.id } }), { code: "P2003" });
    });
    await t.test("database rejects invalid names, order and revision", async () => {
      for (const data of [{ name: " " }, { name: randomUUID(), displayOrder: -1 }, { name: randomUUID(), revision: 0 }]) await assert.rejects(db.category.create({ data }));
    });
  } finally { await db.$disconnect(); }
});
