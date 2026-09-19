import "server-only";
import type { Prisma } from "../../generated/prisma/client";
import type { BaseUnit } from "./domain";
import { remainingStock, saleQuantity, SaleStockError, stockDecimal } from "./sale-domain";

/** Internal payment integration only. Caller holds Shift -> Order -> Payment locks
 * and records success in THIS transaction. Never call for an already committed
 * payment: payment replay returns before this point. There is no stock action.
 */
export async function consumePaidOrderStock(tx: Prisma.TransactionClient, paymentId: string, actorId: string | null) {
  const payment = await tx.payment.findUniqueOrThrow({ where: { id: paymentId }, include: { order: { include: { items: true } } } });
  if (payment.status !== "SUCCEEDED" || payment.order.status !== "PAID" || !payment.order.items.length) {
    throw new SaleStockError("INVALID_INVENTORY_STATE");
  }
  // Product locks also cover missing recipes and match 7F's recipe-save lock.
  // Hold all of them until commit, then lock shared ingredients in receiving order.
  const productIds = [...new Set(payment.order.items.map(item => item.productId))].sort();
  for (const id of productIds) await tx.$queryRaw`SELECT id FROM "Product" WHERE id = ${id}::uuid FOR SHARE`;
  const recipes = await tx.recipe.findMany({ where: { productId: { in: productIds } }, include: { items: true } });
  for (const id of productIds) {
    if (!recipes.find(recipe => recipe.productId === id)?.items.length) throw new SaleStockError("RECIPE_NOT_CONFIGURED");
  }
  const ingredientIds = [...new Set(recipes.flatMap(recipe => recipe.items.map(item => item.ingredientId)))].sort();
  const lines = [];
  for (const id of ingredientIds) {
    await tx.$queryRaw`SELECT id FROM "Ingredient" WHERE id = ${id}::uuid FOR UPDATE`;
    const ingredient = await tx.ingredient.findUnique({ where: { id } });
    if (!ingredient || !["g", "ml", "pcs"].includes(ingredient.baseUnit)) throw new SaleStockError("INVALID_INVENTORY_STATE");
    if (!ingredient.active) throw new SaleStockError("RECIPE_INGREDIENT_INACTIVE");
    let quantity = BigInt(0);
    for (const item of payment.order.items) {
      const recipeItem = recipes.find(recipe => recipe.productId === item.productId)!.items.find(line => line.ingredientId === id);
      if (recipeItem) quantity += saleQuantity(recipeItem.quantity.toFixed(), recipeItem.unit, ingredient.baseUnit as BaseUnit, item.quantity);
    }
    // Check sufficiency before formatting so even an oversized aggregate returns
    // the controlled insufficient-stock error, without numeric overflow.
    const stockAfter = remainingStock(ingredient.currentStock.toFixed(), quantity);
    lines.push({ ingredientId: id, unit: ingredient.baseUnit, quantity: stockDecimal(quantity), stockAfter });
  }
  for (const line of lines) {
    await tx.ingredient.update({ where: { id: line.ingredientId }, data: { currentStock: line.stockAfter } });
    await tx.stockMovement.create({ data: { ...line, type: "SALE_CONSUMPTION", sourceType: "Payment", sourceId: payment.id,
      paymentId: payment.id, actorId } });
  }
}
