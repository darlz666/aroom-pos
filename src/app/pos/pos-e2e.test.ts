import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { test } from "node:test";
import type { PrismaClient } from "../../generated/prisma/client";

type StoredProduct = {
  id: string;
  name: string;
  price: number;
  active: boolean;
  available: boolean;
};

type StoredShift = {
  id: string;
  cashierId: string;
  status: "OPEN" | "CLOSED";
  openedAt: Date;
  closedAt: Date | null;
  openingCash: number;
  expectedCash: number | null;
  countedCash: number | null;
  variance: number | null;
  closingNote: string | null;
};

type StoredItem = {
  id: string;
  orderId: string;
  productId: string;
  productNameSnapshot: string;
  unitPriceSnapshot: number;
  quantity: number;
  lineTotal: number;
};

type StoredOrder = {
  id: string;
  orderNumber: string;
  revision: number;
  createIdempotencyKey: string;
  createRequestFingerprint: string;
  shiftId: string;
  cashierId: string;
  orderType: "DINE_IN" | "TAKEAWAY";
  status: "UNPAID" | "PAID" | "CANCELLED";
  total: number;
  createdAt: Date;
  paidAt: Date | null;
  cancelledAt: Date | null;
  items: StoredItem[];
};

type StoredPayment = {
  id: string;
  orderId: string;
  method: "CASH" | "BCA_EDC" | "MIDTRANS_QRIS";
  status: "PENDING" | "SUCCEEDED" | "FAILED" | "EXPIRED" | "CANCELLED";
  amount: number;
  attemptIdentifier: string;
  requestFingerprint: string;
  cashReceived: number | null;
  changeAmount: number | null;
  edcReference: string | null;
  midtransReference: string | null;
  createdAt: Date;
  updatedAt: Date;
  succeededAt: Date | null;
};

function createPosDatabase(actor: { id: string; name: string }, product: StoredProduct) {
  const shifts: StoredShift[] = [];
  const orders: StoredOrder[] = [];
  const payments: StoredPayment[] = [];
  const auditActions: string[] = [];
  let orderSequence = BigInt(0);

  const paymentRows = (shiftId: string) => payments.filter((payment) => {
    const order = orders.find((candidate) => candidate.id === payment.orderId);
    return payment.status === "SUCCEEDED" && order?.shiftId === shiftId && order.status === "PAID";
  });

  const tx = {
    shift: {
      findFirst: async () => shifts.find((shift) => shift.status === "OPEN") ?? null,
      create: async ({ data }: { data: { cashierId: string; status: "OPEN"; openingCash: number } }) => {
        const shift: StoredShift = {
          id: randomUUID(),
          cashierId: data.cashierId,
          status: data.status,
          openedAt: new Date("2026-09-17T01:00:00.000Z"),
          closedAt: null,
          openingCash: data.openingCash,
          expectedCash: null,
          countedCash: null,
          variance: null,
          closingNote: null,
        };
        shifts.push(shift);
        return shift;
      },
      findUniqueOrThrow: async ({ where }: { where: { id: string } }) => {
        const shift = shifts.find((candidate) => candidate.id === where.id);
        if (!shift) throw new Error("Shift not found");
        return shift;
      },
      update: async ({ where, data }: { where: { id: string }; data: Partial<StoredShift> }) => {
        const shift = shifts.find((candidate) => candidate.id === where.id);
        if (!shift) throw new Error("Shift not found");
        Object.assign(shift, data);
        return shift;
      },
    },
    product: {
      findMany: async ({ where }: { where: { id: { in: string[] } } }) =>
        where.id.in.includes(product.id) ? [product] : [],
      findUnique: async ({ where }: { where: { id: string } }) =>
        where.id === product.id ? product : null,
    },
    order: {
      findUnique: async (args: {
        where: { id?: string; createIdempotencyKey?: string };
        select?: Record<string, unknown>;
        include?: Record<string, unknown>;
      }) => {
        const order = args.where.id
          ? orders.find((candidate) => candidate.id === args.where.id)
          : orders.find((candidate) => candidate.createIdempotencyKey === args.where.createIdempotencyKey);
        if (!order) return null;
        if (args.include) {
          return {
            ...order,
            items: order.items.map((item) => ({ ...item, product })),
          };
        }
        if (args.select?.cashier) {
          return {
            ...order,
            cashier: { name: actor.name },
            payments: payments.filter((payment) => payment.orderId === order.id && payment.status === "SUCCEEDED"),
          };
        }
        return order;
      },
      findFirst: async ({ where }: { where: { shiftId: string; status: string } }) =>
        orders.find((order) => order.shiftId === where.shiftId && order.status === where.status) ?? null,
      create: async ({ data }: {
        data: Omit<StoredOrder, "id" | "createdAt" | "items"> & {
          items: { create: Array<Omit<StoredItem, "id" | "orderId">> };
        };
      }) => {
        const orderId = randomUUID();
        const { items, ...orderData } = data;
        const order: StoredOrder = {
          ...orderData,
          id: orderId,
          createdAt: new Date("2026-09-17T01:05:00.000Z"),
          items: items.create.map((item) => ({ ...item, id: randomUUID(), orderId })),
        };
        orders.push(order);
        return order;
      },
      update: async ({ where, data }: {
        where: { id: string };
        data: Omit<Partial<StoredOrder>, "revision"> & { revision?: number | { increment: number } };
      }) => {
        const order = orders.find((candidate) => candidate.id === where.id);
        if (!order) throw new Error("Order not found");
        const { revision, ...changes } = data;
        Object.assign(order, changes);
        if (typeof revision === "number") order.revision = revision;
        else if (revision) order.revision += revision.increment;
        return order;
      },
      groupBy: async ({ where }: { where: { shiftId: string } }) =>
        (["PAID", "UNPAID", "CANCELLED"] as const).map((status) => ({
          status,
          _count: { _all: orders.filter((order) => order.shiftId === where.shiftId && order.status === status).length },
        })),
    },
    orderItem: {
      update: async ({ where, data }: { where: { id: string }; data: { quantity: number; lineTotal: number } }) => {
        const item = orders.flatMap((order) => order.items).find((candidate) => candidate.id === where.id);
        if (!item) throw new Error("Order item not found");
        Object.assign(item, data);
        return item;
      },
      findMany: async ({ where }: { where: { orderId: string } }) =>
        orders.find((order) => order.id === where.orderId)?.items.map(({ lineTotal }) => ({ lineTotal })) ?? [],
    },
    payment: {
      findUnique: async ({ where }: { where: { attemptIdentifier: string } }) =>
        payments.find((payment) => payment.attemptIdentifier === where.attemptIdentifier) ?? null,
      findFirst: async ({ where }: { where: { order: { shiftId: string }; status: string } }) =>
        payments.find((payment) => {
          const order = orders.find((candidate) => candidate.id === payment.orderId);
          return order?.shiftId === where.order.shiftId && payment.status === where.status;
        }) ?? null,
      create: async ({ data }: { data: Omit<StoredPayment, "id" | "createdAt" | "updatedAt" | "midtransReference"> }) => {
        const payment: StoredPayment = {
          ...data,
          id: randomUUID(),
          midtransReference: null,
          createdAt: data.succeededAt ?? new Date(),
          updatedAt: data.succeededAt ?? new Date(),
        };
        payments.push(payment);
        return payment;
      },
      aggregate: async ({ where }: { where: { method: StoredPayment["method"]; order: { shiftId: string } } }) => ({
        _sum: {
          amount: paymentRows(where.order.shiftId)
            .filter((payment) => payment.method === where.method)
            .reduce((total, payment) => total + payment.amount, 0),
        },
      }),
      groupBy: async ({ where }: { where: { order: { shiftId: string } } }) => {
        const rows = paymentRows(where.order.shiftId);
        return (["CASH", "BCA_EDC", "MIDTRANS_QRIS"] as const).map((method) => ({
          method,
          _sum: { amount: rows.filter((payment) => payment.method === method).reduce((total, payment) => total + payment.amount, 0) },
        }));
      },
    },
    auditLog: {
      create: async ({ data }: { data: { action: string } }) => {
        auditActions.push(data.action);
        return data;
      },
    },
    $queryRaw: async (sql: TemplateStringsArray, ...values: unknown[]) => {
      const query = sql.join("?");
      if (query.includes("nextval")) return [{ value: ++orderSequence }];
      if (query.includes('FROM "Shift"')) {
        return shifts.filter((shift) => shift.id === values[0]);
      }
      if (query.includes('FROM "Order"')) {
        return orders.filter((order) => order.id === values[0]).map(({ id }) => ({ id }));
      }
      if (query.includes('FROM "Payment"')) {
        return payments.filter((payment) => payment.orderId === values[0]).map(({ status }) => ({ status }));
      }
      throw new Error(`Unexpected SQL in POS fixture: ${query}`);
    },
  };

  const db = {
    ...tx,
    $transaction: async (work: (client: typeof tx) => Promise<unknown>) => work(tx),
  } as unknown as PrismaClient;

  return { db, shifts, orders, payments, auditActions };
}

test("POS lifecycle: open, create, edit, pay, receipt, settle, close", async (t) => {
  const require = createRequire(import.meta.url);
  const serverOnlyPath = require.resolve("server-only");
  const originalServerOnly = require.cache[serverOnlyPath];
  require.cache[serverOnlyPath] = { exports: {} } as NodeModule;
  t.after(() => {
    if (originalServerOnly) require.cache[serverOnlyPath] = originalServerOnly;
    else delete require.cache[serverOnlyPath];
  });

  const [{ openShift, closeShift }, { createOrder, editOrder }, { recordManualPayment }, { getReceipt }, { getShiftSettlement }] =
    await Promise.all([
      import("../../lib/shifts/service"),
      import("../../lib/orders/service"),
      import("../../lib/payments/service"),
      import("../../lib/orders/receipt"),
      import("../../lib/shifts/settlement"),
    ]);

  const actor = { id: randomUUID(), name: "Ayu", role: "CASHIER" as const };
  const product: StoredProduct = {
    id: randomUUID(),
    name: "Kopi Susu AROOM",
    price: 22000,
    active: true,
    available: true,
  };
  const state = createPosDatabase(actor, product);

  const opened = await openShift(state.db, actor, 100000);
  assert.equal(opened.state, "CREATED");
  assert.equal(opened.shift.status, "OPEN");
  assert.equal(opened.shift.openingCash, 100000);

  const created = await createOrder(state.db, actor, {
    createIdempotencyKey: randomUUID(),
    orderType: "DINE_IN",
    items: [{ productId: product.id, quantity: 1 }],
  });
  assert.equal(created.replayed, false);
  assert.equal(created.revision, 1);
  assert.equal(created.total, 22000);
  assert.deepEqual(created.items.map(({ productName, unitPrice, quantity, lineTotal }) =>
    ({ productName, unitPrice, quantity, lineTotal })), [
    { productName: "Kopi Susu AROOM", unitPrice: 22000, quantity: 1, lineTotal: 22000 },
  ]);

  const edited = await editOrder(state.db, actor, {
    orderId: created.id,
    expectedRevision: created.revision,
    operation: { type: "SET_QUANTITY", orderItemId: created.items[0].id, quantity: 2 },
  });
  assert.equal(edited.revision, 2);
  assert.equal(edited.total, 44000);
  assert.equal(edited.items[0].quantity, 2);
  assert.equal(edited.items[0].lineTotal, 44000);

  const paid = await recordManualPayment(state.db, actor, {
    orderId: edited.id,
    expectedRevision: edited.revision,
    attemptIdentifier: randomUUID(),
    method: "CASH",
    cashReceived: 50000,
  });
  assert.equal(paid.replayed, false);
  assert.equal(paid.status, "SUCCEEDED");
  assert.equal(paid.amount, 44000);
  assert.equal(paid.changeAmount, 6000);
  assert.equal(state.orders[0].status, "PAID");
  assert.equal(state.orders[0].revision, 3);

  product.name = "Renamed Menu Coffee";
  product.price = 99000;
  const receipt = await getReceipt(state.db, actor, created.id);
  assert.equal(receipt.cashier, "Ayu");
  assert.equal(receipt.total, 44000);
  assert.deepEqual(receipt.items, [
    { name: "Kopi Susu AROOM", unitPrice: 22000, quantity: 2, lineTotal: 44000 },
  ]);
  assert.deepEqual(receipt.payment, {
    method: "CASH",
    amount: 44000,
    cashReceived: 50000,
    changeAmount: 6000,
    edcReference: null,
    succeededAt: paid.succeededAt,
  });

  const settlement = await getShiftSettlement(state.db, opened.shift.id);
  assert.deepEqual({
    totalOrders: settlement.totalOrders,
    paidOrders: settlement.paidOrders,
    cancelledOrders: settlement.cancelledOrders,
    grossSales: settlement.grossSales,
    cashSales: settlement.cashSales,
    edcSales: settlement.edcSales,
    expectedCash: settlement.expectedCash,
  }, {
    totalOrders: 1,
    paidOrders: 1,
    cancelledOrders: 0,
    grossSales: 44000,
    cashSales: 44000,
    edcSales: 0,
    expectedCash: 144000,
  });

  const closed = await closeShift(state.db, actor, {
    shiftId: opened.shift.id,
    countedCash: settlement.expectedCash,
  });
  assert.equal(closed.status, "CLOSED");
  assert.equal(closed.expectedCash, 144000);
  assert.equal(closed.countedCash, 144000);
  assert.equal(closed.cashVariance, 0);
  assert.equal(state.shifts[0].status, "CLOSED");
  assert.equal(state.payments.length, 1);
  assert.deepEqual(state.auditActions, [
    "SHIFT_OPENED",
    "ORDER_CREATED",
    "ORDER_UPDATED",
    "PAYMENT_SUCCEEDED",
    "SHIFT_CLOSED",
  ]);
});
