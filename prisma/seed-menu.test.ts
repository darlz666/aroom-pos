import "dotenv/config";
import assert from "node:assert/strict";
import { test } from "node:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client";
import { categories, products, seedMenu } from "./seed-menu";

test("seed restores confirmed menu values without duplicates or non-menu changes", async () => {
  assert.notEqual(process.env.NODE_ENV, "production");
  assert.ok(process.env.DATABASE_URL, "A development DATABASE_URL is required");
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
  });
  const rollback = new Error("Rollback test changes");
  try {
    await assert.rejects(prisma.$transaction(async (tx) => {
      const nonMenuCounts = () => Promise.all([
        tx.user.count(), tx.shift.count(), tx.order.count(), tx.orderItem.count(),
        tx.payment.count(), tx.paymentNotification.count(), tx.auditLog.count(),
      ]);
      const before = await nonMenuCounts();
      await seedMenu(tx);
      const counts = [await tx.category.count(), await tx.product.count()];
      const product = await tx.product.update({
        where: { id: products[0].id },
        data: { name: "Edited coffee", price: 31000, categoryId: categories[3].id, available: false, active: false },
      });
      const category = await tx.category.update({
        where: { id: categories[0].id },
        data: { name: "Edited category", displayOrder: 99, active: false },
      });
      assert.deepEqual(await seedMenu(tx), { categories: 4, products: 23 });
      assert.deepEqual(await seedMenu(tx), { categories: 4, products: 23 });
      assert.deepEqual([await tx.category.count(), await tx.product.count()], counts);
      const savedCategories = await tx.category.findMany({
        where: { id: { in: categories.map((row) => row.id) } }, orderBy: { displayOrder: "asc" },
      });
      assert.deepEqual(savedCategories, categories);
      const savedProducts = await tx.product.findMany({
        where: { id: { in: products.map((row) => row.id) } },
        select: { id: true, categoryId: true, name: true, price: true, active: true, available: true },
        orderBy: { id: "asc" },
      });
      assert.deepEqual(savedProducts, [...products].sort((a, b) => a.id.localeCompare(b.id)));
      assert.deepEqual((await tx.product.findUniqueOrThrow({ where: { id: product.id } })).createdAt, product.createdAt);
      assert.equal((await tx.category.findUniqueOrThrow({ where: { id: category.id } })).active, true);
      assert.deepEqual(await nonMenuCounts(), before);
      throw rollback;
    }), (error: unknown) => error === rollback);
  } finally {
    await prisma.$disconnect();
  }
});
