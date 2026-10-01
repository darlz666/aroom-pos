import "server-only";

import type { PrismaClient } from "../../generated/prisma/client";
import type { AuthenticatedUser } from "../auth/credentials";
import { jakartaBusinessDate } from "../reports/domain";
import { inventoryValue } from "../finance/service";
import { InventoryError } from "./domain";

export const stockDashboardPeriods = [
  "TODAY",
  "7D",
  "30D",
  "MONTH",
] as const;

export type StockDashboardPeriod =
  (typeof stockDashboardPeriods)[number];

const inboundTypes = new Set([
  "PURCHASE",
  "ADJUSTMENT_IN",
]);

const outboundTypes = new Set([
  "SALE_CONSUMPTION",
  "ADJUSTMENT_OUT",
]);

function addDays(value: string, days: number) {
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + days));

  return [
    date.getUTCFullYear(),
    String(date.getUTCMonth() + 1).padStart(2, "0"),
    String(date.getUTCDate()).padStart(2, "0"),
  ].join("-");
}

function nextMonth(value: string) {
  const [year, month] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month, 1));

  return [
    date.getUTCFullYear(),
    String(date.getUTCMonth() + 1).padStart(2, "0"),
    "01",
  ].join("-");
}

function parsePeriod(input: unknown): StockDashboardPeriod {
  if (
    !input ||
    typeof input !== "object" ||
    !("period" in input)
  ) {
    return "30D";
  }

  const period = (input as { period?: unknown }).period;

  if (
    typeof period !== "string" ||
    !stockDashboardPeriods.includes(
      period as StockDashboardPeriod
    )
  ) {
    throw new InventoryError("INVALID_INPUT");
  }

  return period as StockDashboardPeriod;
}

export function stockDashboardPeriodRange(
  input: unknown,
  now = new Date()
) {
  const period = parsePeriod(input);
  const today = jakartaBusinessDate(now);

  let startDate: string;

  if (period === "TODAY") {
    startDate = today;
  } else if (period === "7D") {
    startDate = addDays(today, -6);
  } else if (period === "30D") {
    startDate = addDays(today, -29);
  } else {
    startDate = `${today.slice(0, 7)}-01`;
  }

  const endDate =
    period === "MONTH"
      ? nextMonth(startDate)
      : addDays(today, 1);

  return {
    period,
    startDate,
    endDate,
    start: new Date(`${startDate}T00:00:00+07:00`),
    end: new Date(`${endDate}T00:00:00+07:00`),
  };
}

export async function getStockDashboard(
  db: PrismaClient,
  actor: AuthenticatedUser,
  input: unknown = {}
) {
  void actor;

  const range = stockDashboardPeriodRange(input);
  const now = new Date();

  const [ingredients, movements, recentMovements] =
    await Promise.all([
      db.ingredient.findMany({
        orderBy: [
          { name: "asc" },
          { id: "asc" },
        ],
        select: {
          id: true,
          name: true,
          baseUnit: true,
          currentStock: true,
          minimumStock: true,
          active: true,
          weightedAverageUnitCostMicros: true,
        },
      }),

      db.stockMovement.findMany({
        where: {
          createdAt: {
            gte: range.start,
            lt: range.end,
          },
        },
        select: {
          type: true,
          createdAt: true,
        },
        orderBy: {
          createdAt: "asc",
        },
      }),

      db.stockMovement.findMany({
        where: {
          createdAt: {
            gte: range.start,
            lt: range.end,
          },
        },
        orderBy: {
          createdAt: "desc",
        },
        take: 12,
        select: {
          id: true,
          type: true,
          quantity: true,
          stockAfter: true,
          createdAt: true,
          sourceType: true,
          ingredient: {
            select: {
              name: true,
              baseUnit: true,
            },
          },
          actor: {
            select: {
              name: true,
            },
          },
        },
      }),
    ]);

  const hasNegativeStock = ingredients.some(
  row => row.currentStock.lt(0)
);

const valuation = hasNegativeStock
  ? {
      amount: null,
      missing: ingredients.filter(
        row =>
          row.currentStock.gt(0) &&
          row.weightedAverageUnitCostMicros === null
      ).length,
    }
  : inventoryValue(ingredients);

  const activeIngredientCount =
    ingredients.filter(row => row.active).length;

  const emptyIngredientCount =
    ingredients.filter(
      row =>
        row.active &&
        row.currentStock.isZero()
    ).length;

  const lowIngredientCount =
    ingredients.filter(
      row =>
        row.active &&
        row.currentStock.gt(0) &&
        row.minimumStock.gt(0) &&
        row.currentStock.lte(row.minimumStock)
    ).length;

  const negativeStockCount =
    ingredients.filter(
      row => row.currentStock.lt(0)
    ).length;

  const missingCostCount = valuation.missing;

  let stockInMovementCount = 0;
  let stockOutMovementCount = 0;

  const daily = new Map<
    string,
    { stockIn: number; stockOut: number }
  >();

  for (
    let day = range.startDate;
    day < range.endDate;
    day = addDays(day, 1)
  ) {
    daily.set(day, {
      stockIn: 0,
      stockOut: 0,
    });
  }

  for (const movement of movements) {
    const key = jakartaBusinessDate(
      movement.createdAt
    );

    const bucket = daily.get(key);

    if (!bucket) continue;

    if (inboundTypes.has(movement.type)) {
      stockInMovementCount++;
      bucket.stockIn++;
    }

    if (outboundTypes.has(movement.type)) {
      stockOutMovementCount++;
      bucket.stockOut++;
    }
  }

  const attentionItems = ingredients
    .flatMap(row => {
      let status:
        | "NEGATIVE"
        | "EMPTY"
        | "MISSING_COST"
        | "LOW"
        | null = null;

      if (row.currentStock.lt(0)) {
        status = "NEGATIVE";
      } else if (
        row.active &&
        row.currentStock.isZero()
      ) {
        status = "EMPTY";
      } else if (
        row.currentStock.gt(0) &&
        row.weightedAverageUnitCostMicros === null
      ) {
        status = "MISSING_COST";
      } else if (
        row.active &&
        row.currentStock.gt(0) &&
        row.minimumStock.gt(0) &&
        row.currentStock.lte(row.minimumStock)
      ) {
        status = "LOW";
      }

      if (!status) return [];

      const itemValue =
        status === "NEGATIVE"
            ? { amount: null, missing: 0 }
            : inventoryValue([row]);

      return [{
        id: row.id,
        name: row.name,
        baseUnit: row.baseUnit,
        currentStock: row.currentStock.toFixed(),
        minimumStock: row.minimumStock.toFixed(),
        active: row.active,
        status,
        inventoryValue: itemValue.amount,
      }];
    })
    .sort((a, b) => {
      const priority = {
        NEGATIVE: 0,
        EMPTY: 1,
        MISSING_COST: 2,
        LOW: 3,
      };

      return (
        priority[a.status] -
          priority[b.status] ||
        a.name.localeCompare(
          b.name,
          "id-ID"
        )
      );
    })
    .slice(0, 20);

  return {
    period: {
      type: range.period,
      start: range.start.toISOString(),
      end: range.end.toISOString(),
    },

    snapshot: {
      inventoryValue: valuation.amount,
      inventoryValueComplete:
        valuation.missing === 0,
      missingCostCount,
      activeIngredientCount,
      emptyIngredientCount,
      lowIngredientCount,
      negativeStockCount,
      asOf: now.toISOString(),
    },

    movement: {
      stockInMovementCount,
      stockOutMovementCount,
      series: Array.from(
        daily.entries(),
        ([date, values]) => ({
          date,
          ...values,
        })
      ),
    },

    attentionItems,

    recentMovements:
      recentMovements.map(row => ({
        id: row.id,
        type: row.type,
        quantity: row.quantity.toFixed(),
        stockAfter: row.stockAfter.toFixed(),
        createdAt: row.createdAt.toISOString(),
        sourceType: row.sourceType,
        ingredientName: row.ingredient.name,
        baseUnit: row.ingredient.baseUnit,
        actorName: row.actor?.name ?? null,
      })),
  };
}