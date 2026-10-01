import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import type { PrismaClient } from "../../generated/prisma/client";
import {
  getStockDashboard,
  stockDashboardPeriodRange,
} from "./dashboard-service";

function decimal(value: string) {
  const numeric = Number(value);

  const compare = (other: unknown) =>
    typeof other === "object" &&
    other !== null &&
    "toString" in other
      ? Number(String(other))
      : Number(other);

  return {
    toString: () => value,
    toFixed: () => value,
    isZero: () => numeric === 0,
    gt: (other: unknown) =>
      numeric > compare(other),
    lt: (other: unknown) =>
      numeric < compare(other),
    lte: (other: unknown) =>
      numeric <= compare(other),
  };
}

test(
  "stock dashboard periods use half-open Asia/Jakarta boundaries",
  () => {
    const now = new Date(
      "2026-10-01T06:00:00.000Z"
    );

    const today = stockDashboardPeriodRange(
      { period: "TODAY" },
      now
    );

    assert.equal(
      today.start.toISOString(),
      "2026-09-30T17:00:00.000Z"
    );

    assert.equal(
      today.end.toISOString(),
      "2026-10-01T17:00:00.000Z"
    );

    const sevenDays =
      stockDashboardPeriodRange(
        { period: "7D" },
        now
      );

    assert.equal(
      sevenDays.start.toISOString(),
      "2026-09-24T17:00:00.000Z"
    );

    assert.equal(
      sevenDays.end.toISOString(),
      "2026-10-01T17:00:00.000Z"
    );

    const thirtyDays =
      stockDashboardPeriodRange(
        { period: "30D" },
        now
      );

    assert.equal(
      thirtyDays.start.toISOString(),
      "2026-09-01T17:00:00.000Z"
    );

    assert.equal(
      thirtyDays.end.toISOString(),
      "2026-10-01T17:00:00.000Z"
    );

    const month =
      stockDashboardPeriodRange(
        { period: "MONTH" },
        now
      );

    assert.equal(
      month.start.toISOString(),
      "2026-09-30T17:00:00.000Z"
    );

    assert.equal(
      month.end.toISOString(),
      "2026-10-31T17:00:00.000Z"
    );

    assert.throws(() =>
      stockDashboardPeriodRange(
        { period: "YEAR" },
        now
      )
    );
  }
);

test(
  "stock dashboard reports current inventory health and movement directions without mixing quantities",
  async () => {
    const actor = {
      id: randomUUID(),
      role: "STOCK_MANAGEMENT",
    } as never;

    const ingredients = [
      {
        id: randomUUID(),
        name: "Fresh Milk",
        baseUnit: "ml",
        currentStock: decimal("2000"),
        minimumStock: decimal("5000"),
        active: true,
        weightedAverageUnitCostMicros:
          BigInt(20_000),
      },
      {
        id: randomUUID(),
        name: "Coffee Beans",
        baseUnit: "g",
        currentStock: decimal("0"),
        minimumStock: decimal("1000"),
        active: true,
        weightedAverageUnitCostMicros: null,
      },
      {
        id: randomUUID(),
        name: "Simple Syrup",
        baseUnit: "ml",
        currentStock: decimal("3000"),
        minimumStock: decimal("1000"),
        active: true,
        weightedAverageUnitCostMicros: null,
      },
      {
        id: randomUUID(),
        name: "Old Cup",
        baseUnit: "pcs",
        currentStock: decimal("20"),
        minimumStock: decimal("0"),
        active: false,
        weightedAverageUnitCostMicros:
          BigInt(500_000_000),
      },
    ];

    const movementTime = new Date();

    const movements = [
      {
        type: "PURCHASE",
        createdAt: movementTime,
      },
      {
        type: "ADJUSTMENT_IN",
        createdAt: movementTime,
      },
      {
        type: "SALE_CONSUMPTION",
        createdAt: movementTime,
      },
      {
        type: "ADJUSTMENT_OUT",
        createdAt: movementTime,
      },
    ];

    const recentMovements = [
      {
        id: randomUUID(),
        type: "PURCHASE",
        quantity: decimal("12000"),
        stockAfter: decimal("14000"),
        createdAt: movementTime,
        sourceType: "StockIn",
        ingredient: {
          name: "Fresh Milk",
          baseUnit: "ml",
        },
        actor: {
          name: "Stock Staff",
        },
      },
      {
        id: randomUUID(),
        type: "SALE_CONSUMPTION",
        quantity: decimal("18"),
        stockAfter: decimal("982"),
        createdAt: movementTime,
        sourceType: "Payment",
        ingredient: {
          name: "Coffee Beans",
          baseUnit: "g",
        },
        actor: null,
      },
    ];

    let movementQuery = 0;

    const db = {
      ingredient: {
        findMany: async () => ingredients,
      },

      stockMovement: {
        findMany: async (args: {
          select?: Record<string, unknown>;
        }) => {
          movementQuery++;

          if (
            args.select &&
            "ingredient" in args.select
          ) {
            return recentMovements;
          }

          return movements;
        },
      },
    } as unknown as PrismaClient;

    const result = await getStockDashboard(
      db,
      actor,
      {
        period: "TODAY",
      }
    );

    assert.equal(movementQuery, 2);

    assert.equal(
      result.snapshot.activeIngredientCount,
      3
    );

    assert.equal(
      result.snapshot.emptyIngredientCount,
      1
    );

    assert.equal(
      result.snapshot.lowIngredientCount,
      1
    );

    assert.equal(
      result.snapshot.missingCostCount,
      1
    );

    assert.equal(
      result.snapshot.negativeStockCount,
      0
    );

    assert.equal(
      result.snapshot.inventoryValue,
      null
    );

    assert.equal(
      result.snapshot.inventoryValueComplete,
      false
    );

    assert.equal(
      result.movement.stockInMovementCount,
      2
    );

    assert.equal(
      result.movement.stockOutMovementCount,
      2
    );

    assert.equal(
      result.movement.series.reduce(
        (sum, row) =>
          sum + row.stockIn,
        0
      ),
      2
    );

    assert.equal(
      result.movement.series.reduce(
        (sum, row) =>
          sum + row.stockOut,
        0
      ),
      2
    );

    assert.deepEqual(
      result.attentionItems.map(row => [
        row.name,
        row.status,
      ]),
      [
        ["Coffee Beans", "EMPTY"],
        ["Simple Syrup", "MISSING_COST"],
        ["Fresh Milk", "LOW"],
      ]
    );

    assert.equal(
      result.recentMovements[0].quantity,
      "12000"
    );

    assert.equal(
      result.recentMovements[0].baseUnit,
      "ml"
    );

    assert.equal(
      result.recentMovements[1].quantity,
      "18"
    );

    assert.equal(
      result.recentMovements[1].baseUnit,
      "g"
    );

    // Dashboard counts movement events.
    // It never sums 12000 ml + 18 g into
    // one meaningless stock quantity.
    assert.equal(
      "totalQuantity" in result.movement,
      false
    );
  }
);

test(
  "stock dashboard surfaces negative inventory instead of hiding it",
  async () => {
    const ingredient = {
      id: randomUUID(),
      name: "Cup 12 oz",
      baseUnit: "pcs",
      currentStock: decimal("-2"),
      minimumStock: decimal("10"),
      active: true,
      weightedAverageUnitCostMicros:
        BigInt(500_000_000),
    };

    const db = {
      ingredient: {
        findMany: async () => [ingredient],
      },

      stockMovement: {
        findMany: async () => [],
      },
    } as unknown as PrismaClient;

    const result = await getStockDashboard(
      db,
      {
        id: randomUUID(),
        role: "ADMIN",
      } as never,
      {
        period: "TODAY",
      }
    );

    assert.equal(
      result.snapshot.negativeStockCount,
      1
    );

    assert.equal(
      result.attentionItems.length,
      1
    );

    assert.equal(
      result.attentionItems[0].name,
      "Cup 12 oz"
    );

    assert.equal(
      result.attentionItems[0].status,
      "NEGATIVE"
    );

    assert.equal(
      result.attentionItems[0].currentStock,
      "-2"
    );
  }
);