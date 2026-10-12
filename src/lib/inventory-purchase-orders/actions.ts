"use server";
import { unstable_rethrow } from "next/navigation";
import { requireUser } from "../auth/authorization";
import { prisma } from "../db";
import { InventoryPurchaseOrderError } from "./domain";
import { getInventoryPurchaseOrder, listInventoryPurchaseOrders, readInventoryPurchaseOrderHistory, saveInventoryPurchaseOrder } from "./service";
import { readInventoryPurchaseOrderReceipts, receiveInventoryPurchaseOrder } from "./receiving-service";

async function attempt<T>(work: () => Promise<T>) {
  try { return { success: true, data: await work() } as const; }
  catch (error) {
    unstable_rethrow(error);
    const known = error instanceof InventoryPurchaseOrderError;
    return { success: false, code: known ? error.code : "UNAVAILABLE",
      error: known ? "Permintaan PO ditolak. Periksa akses, status, revisi, supplier, bahan, jumlah dan harga."
        : "Status PO belum dapat dipastikan. Ulangi dengan kunci dan data yang sama.", retryable: !known } as const;
  }
}
export async function inventoryPurchaseOrderWriteAction(input: unknown) {
  return attempt(async () => saveInventoryPurchaseOrder(prisma, await requireUser(), input));
}
export async function inventoryPurchaseOrderListAction(input: unknown = {}) {
  return attempt(async () => listInventoryPurchaseOrders(prisma, await requireUser(), input));
}
export async function inventoryPurchaseOrderDetailAction(input: unknown) {
  return attempt(async () => getInventoryPurchaseOrder(prisma, await requireUser(), input));
}
export async function inventoryPurchaseOrderHistoryAction(input: unknown) {
  return attempt(async () => readInventoryPurchaseOrderHistory(prisma, await requireUser(), input));
}
export async function inventoryPurchaseOrderReceiveAction(input: unknown) {
  return attempt(async () => receiveInventoryPurchaseOrder(prisma, await requireUser(), input));
}
export async function inventoryPurchaseOrderReceiptsAction(input: unknown) {
  return attempt(async () => readInventoryPurchaseOrderReceipts(prisma, await requireUser(), input));
}
