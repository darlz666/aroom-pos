"use server";

import { unstable_rethrow } from "next/navigation";
import { requireUser } from "../auth/authorization";
import { prisma } from "../db";
import { OrderError, type OrderErrorCode } from "./domain";
import { getReceipt } from "./receipt";
import { getHistoricalOrder, listOrderHistory } from "./history";
import { cancelOrder, createOrder, editOrder, getActiveUnpaidOrder, listActiveUnpaidOrders, type EditOrderResult } from "./service";
export type { SafeOrder } from "./service";

const messages = {
  INVALID_INPUT: "Data pesanan tidak valid. Periksa isian pesanan.",
  INVALID_IDEMPOTENCY_KEY: "Identitas permintaan pesanan tidak valid.",
  IDEMPOTENCY_CONFLICT: "Identitas permintaan sudah digunakan. Muat ulang status pesanan sebelum melanjutkan.",
  NO_ACTIVE_SHIFT: "Shift tidak aktif. Periksa status shift sebelum melanjutkan.",
  FORBIDDEN: "Anda tidak memiliki izin untuk tindakan ini.",
  PRODUCT_NOT_FOUND: "Produk tidak ditemukan. Muat ulang daftar produk.",
  PRODUCT_UNAVAILABLE: "Produk sedang tidak tersedia. Periksa kembali pesanan.",
  INVALID_QUANTITY: "Jumlah produk harus berupa angka bulat antara 1 dan 99.",
  TOO_MANY_ITEMS: "Jumlah jenis produk melebihi batas pesanan.",
  MONEY_OVERFLOW: "Nominal pesanan melebihi batas yang didukung.",
  CREATE_FAILED: "Status pembuatan pesanan belum dapat dipastikan. Periksa koneksi dan ulangi dengan identitas permintaan serta isi pesanan yang sama.",
  ORDER_NOT_FOUND: "Pesanan tidak ditemukan. Muat ulang status pesanan.",
  ORDER_NOT_EDITABLE: "Pesanan sudah dibayar atau dibatalkan dan tidak dapat diubah.",
  REVISION_CONFLICT: "Pesanan telah berubah. Muat ulang pesanan dan tinjau perubahan sebelum mencoba lagi.",
  ORDER_ITEM_NOT_FOUND: "Item pesanan tidak ditemukan. Muat ulang pesanan.",
  EMPTY_ORDER_NOT_ALLOWED: "Pesanan harus memiliki setidaknya satu item. Gunakan pembatalan untuk membatalkan pesanan.",
  PAYMENT_BLOCKED: "Pesanan memiliki pembayaran yang belum selesai atau sudah berhasil. Periksa status pembayaran sebelum melanjutkan.",
  UPDATE_FAILED: "Status perubahan belum dapat dipastikan. Periksa koneksi dan muat ulang pesanan sebelum mencoba lagi.",
  CANCEL_FAILED: "Status pembatalan belum dapat dipastikan. Periksa koneksi dan muat ulang pesanan sebelum mencoba lagi.",
} satisfies Record<OrderErrorCode, string>;

function safeFailure(error: unknown, fallback: "CREATE_FAILED" | "UPDATE_FAILED" | "CANCEL_FAILED") {
  // Preserve Next authentication redirects while sanitizing ordinary auth/DB failures.
  unstable_rethrow(error);
  const code = error instanceof OrderError && Object.hasOwn(messages, error.code) ? error.code : fallback;
  return { success: false, code, error: messages[code] } as const;
}

function orderDto(order: EditOrderResult) {
  return {
    id: order.id, orderNumber: order.orderNumber, status: order.status, revision: order.revision,
    shiftId: order.shiftId, cashierId: order.cashierId, orderType: order.orderType,
    total: order.total, createdAt: order.createdAt,
    items: order.items.map((item) => ({ id: item.id, productId: item.productId,
      productName: item.productName, unitPrice: item.unitPrice, quantity: item.quantity, lineTotal: item.lineTotal })),
  };
}

export async function createOrderAction(input: unknown) {
  try {
    const actor = await requireUser();
    // Services own strict input validation; do not strip unexpected request fields.
    const order = await createOrder(prisma, actor, input);
    return { success: true, order: { ...orderDto(order), replayed: order.replayed } } as const;
  } catch (error) {
    return safeFailure(error, "CREATE_FAILED");
  }
}

export async function editOrderAction(input: unknown) {
  try {
    const actor = await requireUser();
    const order = await editOrder(prisma, actor, input);
    return { success: true, order: orderDto(order) } as const;
  } catch (error) {
    return safeFailure(error, "UPDATE_FAILED");
  }
}

export async function cancelOrderAction(input: unknown) {
  try {
    const actor = await requireUser();
    const order = await cancelOrder(prisma, actor, input);
    return { success: true, order: orderDto(order) } as const;
  } catch (error) {
    return safeFailure(error, "CANCEL_FAILED");
  }
}

export async function listActiveUnpaidOrdersAction() {
  try {
    const actor = await requireUser();
    return { success: true, orders: (await listActiveUnpaidOrders(prisma, actor)).map(orderDto) } as const;
  } catch (error) {
    return safeFailure(error, "UPDATE_FAILED");
  }
}

export async function getActiveUnpaidOrderAction(orderId: unknown) {
  try {
    const actor = await requireUser();
    if (typeof orderId !== "string") throw new OrderError("INVALID_INPUT");
    return { success: true, order: orderDto(await getActiveUnpaidOrder(prisma, actor, orderId)) } as const;
  } catch (error) {
    return safeFailure(error, "UPDATE_FAILED");
  }
}

export async function getReceiptAction(orderId: unknown) {
  try {
    const actor = await requireUser();
    if (typeof orderId !== "string") throw new OrderError("INVALID_INPUT");
    return { success: true, receipt: await getReceipt(prisma, actor, orderId) } as const;
  } catch (error) {
    return safeFailure(error, "UPDATE_FAILED");
  }
}

export async function listOrderHistoryAction(input: unknown = {}) {
  try {
    const actor = await requireUser();
    return { success: true, ...await listOrderHistory(prisma, actor, input) } as const;
  } catch (error) {
    return safeFailure(error, "UPDATE_FAILED");
  }
}

export async function getHistoricalOrderAction(orderId: unknown) {
  try {
    const actor = await requireUser();
    return { success: true, order: await getHistoricalOrder(prisma, actor, orderId) } as const;
  } catch (error) {
    return safeFailure(error, "UPDATE_FAILED");
  }
}
