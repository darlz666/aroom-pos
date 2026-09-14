import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient, type Prisma } from "../src/generated/prisma/client";

test("order PostgreSQL foundation (all fixtures rolled back)", async (t) => {
  assert.notEqual(process.env.NODE_ENV, "production");
  assert.ok(process.env.DATABASE_URL);
  assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(new URL(process.env.DATABASE_URL).hostname), "Requires local development database");
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });
  const rollback = new Error("rollback order fixtures");
  const fixtureUserId = randomUUID();
  try {
    await assert.rejects(db.$transaction(async (tx) => {
      const user = await tx.user.create({ data: { id: fixtureUserId, name: "Order integrity fixture", loginIdentifier: randomUUID(), passwordHash: "unused", role: "CASHIER" } });
      const shift = await tx.shift.create({ data: { cashierId: user.id, status: "CLOSED", closedAt: new Date(), openingCash: 0 } });
      const category = await tx.category.create({ data: { name: "Order fixture" } });
      const product = await tx.product.create({ data: { categoryId: category.id, name: "Coffee", price: 22000 } });
      const createOrder = (overrides: Partial<Prisma.OrderUncheckedCreateInput> = {}) => tx.order.create({ data: {
        shiftId: shift.id, cashierId: user.id, orderType: "DINE_IN", total: 22000,
        orderNumber: `integrity-${randomUUID()}`, createIdempotencyKey: randomUUID(), createRequestFingerprint: "fixture-original-request",
        ...overrides,
      } });
      const order = await createOrder();
      const createItem = (overrides: Partial<Prisma.OrderItemUncheckedCreateInput> = {}) => tx.orderItem.create({ data: {
        orderId: order.id, productId: product.id, productNameSnapshot: product.name,
        unitPriceSnapshot: 22000, quantity: 1, lineTotal: 22000, ...overrides,
      } });
      // Raw SQL errors expose SQLSTATE. Savepoints recover after deliberate violations.
      const rejected = async (name: string, operation: () => Promise<unknown>, expected: string) => {
        await t.test(name, async () => {
          await tx.$executeRawUnsafe("SAVEPOINT invalid_row");
          try {
            await assert.rejects(operation(), (error: unknown) => {
              assert.ok(error && typeof error === "object");
              const failure = error as { code?: string; cause?: { originalCode?: string }; meta?: { code?: string; driverAdapterError?: { cause?: { originalCode?: string } } } };
              const sqlState = failure.cause?.originalCode ?? failure.meta?.driverAdapterError?.cause?.originalCode ?? failure.meta?.code;
              assert.equal(expected.startsWith("P") ? failure.code : sqlState, expected);
              return true;
            });
          } finally { await tx.$executeRawUnsafe("ROLLBACK TO SAVEPOINT invalid_row"); }
        });
      };
      await t.test("revision defaults to 1 in PostgreSQL", async () => {
        const [row] = await tx.$queryRaw<{ revision: number }[]>`
          INSERT INTO "Order" (id, "orderNumber", "shiftId", "cashierId", "orderType", total,
            "createIdempotencyKey", "createRequestFingerprint")
          VALUES (${randomUUID()}::uuid, ${randomUUID()}, ${shift.id}::uuid, ${user.id}::uuid,
            'DINE_IN', 0, ${randomUUID()}::uuid, 'fixture-original-request')
          RETURNING revision`;
        assert.equal(row.revision, 1);
      });
      await rejected("revision 0 rejected", () => tx.$executeRaw`UPDATE "Order" SET "revision" = 0 WHERE id = ${order.id}::uuid`, "23514");
      await rejected("negative total rejected", () => tx.$executeRaw`UPDATE "Order" SET total = -1 WHERE id = ${order.id}::uuid`, "23514");
      await rejected("duplicate create key rejected", () => createOrder({ createIdempotencyKey: order.createIdempotencyKey }), "P2002");
      await t.test("distinct keys accepted", async () => { assert.notEqual((await createOrder()).createIdempotencyKey, order.createIdempotencyKey); });
      await rejected("duplicate order number rejected", () => createOrder({ orderNumber: order.orderNumber }), "P2002");
      await rejected("create key immutable", () => tx.$executeRaw`UPDATE "Order" SET "createIdempotencyKey" = ${randomUUID()}::uuid WHERE id = ${order.id}::uuid`, "23514");
      await rejected("original fingerprint immutable", () => tx.$executeRaw`UPDATE "Order" SET "createRequestFingerprint" = 'changed' WHERE id = ${order.id}::uuid`, "23514");
      await t.test("another Order field can change while create fields remain unchanged", async () => {
        const updated = await tx.order.update({ where: { id: order.id }, data: { revision: 2 } });
        assert.equal(updated.revision, 2);
        assert.equal(updated.createIdempotencyKey, order.createIdempotencyKey);
        assert.equal(updated.createRequestFingerprint, order.createRequestFingerprint);
      });
      await t.test("SQL explicitly writing identical create fields is allowed", async () => {
        assert.equal(await tx.$executeRaw`UPDATE "Order"
          SET "createIdempotencyKey" = ${order.createIdempotencyKey}::uuid,
              "createRequestFingerprint" = ${order.createRequestFingerprint}
          WHERE id = ${order.id}::uuid`, 1);
        const updated = await tx.order.findUniqueOrThrow({ where: { id: order.id } });
        assert.equal(updated.revision, 2);
        assert.equal(updated.createIdempotencyKey, order.createIdempotencyKey);
        assert.equal(updated.createRequestFingerprint, order.createRequestFingerprint);
      });
      await t.test("sequence values distinct and increasing", async () => {
        const [first] = await tx.$queryRaw<{ value: bigint }[]>`SELECT nextval('order_number_seq') AS value`;
        const [second] = await tx.$queryRaw<{ value: bigint }[]>`SELECT nextval('order_number_seq') AS value`;
        assert.ok(first.value >= BigInt(1) && second.value > first.value);
      });
      for (const quantity of [1, 99]) {
        await t.test(`quantity ${quantity} accepted`, async () => { await createItem({ quantity, lineTotal: quantity * 22000 }); });
      }
      const item = await createItem();
      const invalidItems = [
        ["quantity 0", 22000, 0, 0], ["quantity 100", 22000, 100, 2200000],
        ["negative price", -1, 1, 0], ["negative line total", 22000, 1, -1],
        ["mismatched subtotal", 22000, 1, 21999],
        ["multiplication beyond Int range", 2147483647, 99, 2147483647],
      ] as const;
      for (const [name, price, quantity, total] of invalidItems) {
        await rejected(`${name} rejected`, () => tx.$executeRaw`UPDATE "OrderItem" SET "unitPriceSnapshot" = ${price}, quantity = ${quantity}, "lineTotal" = ${total} WHERE id = ${item.id}::uuid`, "23514");
      }
      await t.test("maximum safe multiplication boundaries accepted", async () => {
        await createItem({ unitPriceSnapshot: 2147483647, quantity: 1, lineTotal: 2147483647 });
        const price = Math.floor(2147483647 / 99);
        await createItem({ unitPriceSnapshot: price, quantity: 99, lineTotal: price * 99 });
      });
      await rejected("lineTotal column rejects beyond Int range", () => tx.$executeRaw`UPDATE "OrderItem" SET "lineTotal" = 2147483648 WHERE id = ${item.id}::uuid`, "22003");
      const now = new Date();
      const lifecycle = [
        ["UNPAID", now, null], ["UNPAID", null, now],
        ["PAID", null, null], ["PAID", now, now],
        ["CANCELLED", null, null], ["CANCELLED", now, now],
      ] as const;
      for (const [status, paidAt, cancelledAt] of lifecycle) {
        await rejected(`${status} paidAt=${!!paidAt} cancelledAt=${!!cancelledAt} rejected`, () => tx.$executeRaw`UPDATE "Order" SET status = ${status}::"OrderStatus", "paidAt" = ${paidAt}, "cancelledAt" = ${cancelledAt} WHERE id = ${order.id}::uuid`, "23514");
      }
      for (const status of ["UNPAID", "PAID", "CANCELLED"] as const) {
        await t.test(`valid ${status} accepted`, async () => { await createOrder({ status, paidAt: status === "PAID" ? now : null, cancelledAt: status === "CANCELLED" ? now : null }); });
      }
      throw rollback;
    }, { timeout: 30000 }), (error: unknown) => error === rollback);
    assert.equal(await db.user.count({ where: { id: fixtureUserId } }), 0, "Fixture transaction rolled back");
  } finally { await db.$disconnect(); }
});
