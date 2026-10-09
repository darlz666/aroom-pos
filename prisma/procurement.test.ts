import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient, type Prisma } from "../src/generated/prisma/client";
import { readProcurement, saveProcurement } from "../src/lib/procurement/service";
import { saveExpense } from "../src/lib/finance/service";
import { createUser, changeUserRole } from "../src/lib/users/service";

test("Procurement PostgreSQL lifecycle, permissions, concurrency and immutable evidence", async t => {
  const url = new URL(process.env.DATABASE_URL!);
  assert.match(url.pathname, /^\/aroom_report_test_/);
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: url.toString() }) });
  const [buyer, finance, admin, cashier, stock] = await Promise.all((["PROCUREMENT", "FINANCE", "ADMIN", "CASHIER", "STOCK_MANAGEMENT"] as const).map(role => db.user.create({ data: { role, name: role, loginIdentifier: randomUUID(), passwordHash: "unused" } })));
  const draft = { itemName: "Grinder", category: "COFFEE_EQUIPMENT", quantity: 2, unit: "unit", estimatedUnitPrice: 5000000, priority: "IMPORTANT", reason: "Equipment replacement" };
  const create = () => ({ id: randomUUID(), key: randomUUID(), revision: 0, operation: "CREATE", data: draft });
  const step = (id: string, revision: number, operation: string, extra = {}) => ({ id, revision, operation, key: randomUUID(), ...extra });
  const inventoryBefore = await db.ingredient.findMany();
  const movementsBefore = await db.stockMovement.count(), stockInsBefore = await db.stockIn.count(), expensesBefore = await db.financeExpense.count();
  try {
    await t.test("admin can create and assign PROCUREMENT; unauthorized users cannot read or mutate", async () => {
      const user = await createUser(db, admin, { name: "Purchaser", loginIdentifier: randomUUID(), password: "long password", role: "PROCUREMENT" });
      assert.equal(user.role, "PROCUREMENT");
      await changeUserRole(db, admin, { userId: user.id, role: "CASHIER" });
      assert.equal((await changeUserRole(db, admin, { userId: user.id, role: "PROCUREMENT" })).role, "PROCUREMENT");
      for (const actor of [cashier, stock, { ...cashier, role: "PROCUREMENT" as const }]) {
        await assert.rejects(readProcurement(db, actor, {})); await assert.rejects(saveProcurement(db, actor, create()));
      }
      for (const actor of [admin, finance]) await assert.rejects(saveProcurement(db, actor, create()));
      await db.user.update({ where: { id: buyer.id }, data: { active: false } });
      await assert.rejects(saveProcurement(db, buyer, create())); await assert.rejects(readProcurement(db, buyer, {}));
      await db.user.update({ where: { id: buyer.id }, data: { active: true } });
      await assert.rejects(saveExpense(db, buyer, {}));
    });
    const input = create();
    await t.test("duplicate CREATE, draft edit, stale edit and lost-response replay", async () => {
      const results = await Promise.all([saveProcurement(db, buyer, input), saveProcurement(db, buyer, input)]);
      assert.deepEqual(results[0], results[1]);
      assert.equal(await db.procurement.count({ where: { id: input.id } }), 1);
      const edit = { ...input, key: randomUUID(), revision: 1, operation: "EDIT", data: { ...draft, quantity: 3 } };
      await saveProcurement(db, buyer, edit);
      await assert.rejects(saveProcurement(db, buyer, { ...edit, key: randomUUID() }));
      await saveProcurement(db, buyer, input);
      assert.equal((await db.procurement.findUniqueOrThrow({ where: { id: input.id } })).estimatedTotal, 15000000);
      await assert.rejects(saveProcurement(db, buyer, { ...input, data: { ...draft, quantity: 4 } }));
      assert.equal(await db.procurementEvent.count({ where: { procurementId: input.id } }), 2);
    });
    await t.test("submit freezes data; FINANCE-only approval followed by ORDERED and RECEIVED", async () => {
      await saveProcurement(db, buyer, step(input.id, 2, "SUBMIT"));
      await assert.rejects(saveProcurement(db, buyer, { ...input, key: randomUUID(), revision: 3, operation: "EDIT" }));
      for (const actor of [buyer, admin, cashier, stock]) await assert.rejects(saveProcurement(db, actor, step(input.id, 3, "APPROVE")));
      for (const actor of [buyer, admin, finance]) assert.equal((await readProcurement(db, actor, { id: input.id })).detail?.status, "WAITING_APPROVAL");
      const decision = step(input.id, 3, "APPROVE", { note: "Budget approved" });
      await Promise.all([saveProcurement(db, finance, decision), saveProcurement(db, finance, decision)]);
      await assert.rejects(saveProcurement(db, finance, step(input.id, 4, "REJECT", { note: "Stale" })));
      await assert.rejects(saveProcurement(db, buyer, step(input.id, 4, "RECEIVE")));
      await saveProcurement(db, buyer, step(input.id, 4, "ORDER", { actualUnitPrice: 4900000 }));
      await assert.rejects(saveProcurement(db, buyer, step(input.id, 5, "CANCEL", { note: "Too late" })));
      const receive = step(input.id, 5, "RECEIVE");
      await Promise.all([saveProcurement(db, buyer, receive), saveProcurement(db, buyer, receive)]);
      await saveProcurement(db, finance, decision);
      const row = await db.procurement.findUniqueOrThrow({ where: { id: input.id } });
      assert.equal(row.status, "RECEIVED"); assert.equal(row.actualTotal, 14700000); assert.equal(row.decidedBy, finance.id);
      assert.ok(row.decidedAt && row.orderedAt && row.receivedAt); assert.equal(row.revision, 6);
      assert.equal(await db.procurementEvent.count({ where: { procurementId: input.id } }), 6);
      assert.equal(await db.auditLog.count({ where: { entityId: input.id } }), 6);
      await assert.rejects(db.procurementEvent.update({ where: { key: decision.key }, data: { note: "overwrite" } }));
      await assert.rejects(db.procurementEvent.delete({ where: { key: decision.key } }));
      await assert.rejects(db.procurement.delete({ where: { id: input.id } }));
    });
    await t.test("rejected and cancelled terminal paths preserve reasons and history", async () => {
      const rejected = create(); await saveProcurement(db, buyer, rejected);
      await saveProcurement(db, buyer, step(rejected.id, 1, "SUBMIT"));
      await saveProcurement(db, finance, step(rejected.id, 2, "REJECT", { note: "Outside budget" }));
      await assert.rejects(saveProcurement(db, buyer, step(rejected.id, 3, "SUBMIT")));
      assert.equal((await readProcurement(db, finance, { id: rejected.id })).detail?.decisionNote, "Outside budget");
      for (const status of ["DRAFT", "WAITING_APPROVAL", "APPROVED"]) {
        const cancelled = create(); await saveProcurement(db, buyer, cancelled); let revision = 1;
        if (status !== "DRAFT") await saveProcurement(db, buyer, step(cancelled.id, revision++, "SUBMIT"));
        if (status === "APPROVED") await saveProcurement(db, finance, step(cancelled.id, revision++, "APPROVE"));
        await assert.rejects(saveProcurement(db, buyer, step(cancelled.id, revision, "CANCEL")));
        await saveProcurement(db, buyer, step(cancelled.id, revision++, "CANCEL", { note: "No longer needed" }));
        const row = await db.procurement.findUniqueOrThrow({ where: { id: cancelled.id } });
        assert.equal(row.status, "CANCELLED"); assert.equal(row.cancellationReason, "No longer needed"); assert.ok(row.cancelledAt);
        await assert.rejects(saveProcurement(db, buyer, step(cancelled.id, revision, "SUBMIT")));
      }
    });
    await t.test("concurrent decisions have one winner; self-approval remains denied after role change", async () => {
      const request = create(); await saveProcurement(db, buyer, request); await saveProcurement(db, buyer, step(request.id, 1, "SUBMIT"));
      await db.user.update({ where: { id: buyer.id }, data: { role: "FINANCE" } });
      await assert.rejects(saveProcurement(db, buyer, step(request.id, 2, "APPROVE")));
      await assert.rejects(saveProcurement(db, buyer, step(request.id, 2, "REJECT", { note: "Self" })));
      await assert.rejects(saveProcurement(db, buyer, create())); // session role is stale
      await db.user.update({ where: { id: buyer.id }, data: { role: "PROCUREMENT" } });
      const results = await Promise.allSettled([saveProcurement(db, finance, step(request.id, 2, "APPROVE")), saveProcurement(db, finance, step(request.id, 2, "REJECT", { note: "Budget" }))]);
      assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
      assert.equal(await db.procurementEvent.count({ where: { procurementId: request.id } }), 3);
    });
    await t.test("audit failure rolls back request and immutable retry receipt", async () => {
      const broken = new Proxy(db, { get(target, key) {
        if (key !== "$transaction") return Reflect.get(target, key);
        return (work: (tx: Prisma.TransactionClient) => Promise<unknown>) => db.$transaction(tx => work(new Proxy(tx, { get(client, field) {
          if (field === "auditLog") return { create: async () => { throw new Error("injected failure"); } };
          return Reflect.get(client, field);
        } })));
      } });
      const request = create(); await assert.rejects(saveProcurement(broken, buyer, request));
      assert.equal(await db.procurement.count({ where: { id: request.id } }), 0);
      assert.equal(await db.procurementEvent.count({ where: { key: request.key } }), 0);
    });
    await t.test("forged fields and direct SQL integrity violations are rejected", async () => {
      for (const patch of [{ actorId: admin.id }, { status: "APPROVED" }, { estimatedTotal: 1 }]) await assert.rejects(saveProcurement(db, buyer, { ...create(), ...patch }));
      const request = create(); await saveProcurement(db, buyer, request);
      await assert.rejects(db.procurement.update({ where: { id: request.id }, data: { revision: 2, estimatedTotal: 1 } }));
      await saveProcurement(db, buyer, step(request.id, 1, "SUBMIT"));
      await assert.rejects(db.procurement.update({ where: { id: request.id }, data: { revision: 3, status: "CANCELLED", cancelledAt: new Date(), cancellationReason: "cancel", itemName: "Overwritten" } }));
    });
    await t.test("dashboard distinguishes unknown actuals and leaves inventory/costing/expenses unchanged", async () => {
      const request = create(); await saveProcurement(db, buyer, request); await saveProcurement(db, buyer, step(request.id, 1, "SUBMIT"));
      await saveProcurement(db, finance, step(request.id, 2, "APPROVE")); await saveProcurement(db, buyer, step(request.id, 3, "ORDER"));
      const result = await readProcurement(db, admin, {});
      assert.equal(result.dashboard.actual, null); assert.ok(result.dashboard.received >= 1);
      assert.deepEqual(await db.ingredient.findMany(), inventoryBefore);
      assert.equal(await db.stockMovement.count(), movementsBefore); assert.equal(await db.stockIn.count(), stockInsBefore); assert.equal(await db.financeExpense.count(), expensesBefore);
    });
  } finally { await db.$disconnect(); }
});
