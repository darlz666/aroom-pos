"use server";

import { unstable_rethrow } from "next/navigation";
import { requireInventoryManager, requireRecipeReader } from "../auth/authorization";
import { prisma } from "../db";
import { InventoryError } from "./domain";
import { createStockIn, createSupplier, getRecipeHpp, getStockIn, listIngredients, listStockIns, listSuppliers, updateSupplier } from "./service";

function failure(error: unknown) {
  unstable_rethrow(error);
  const code = error instanceof InventoryError ? error.code : "UNAVAILABLE";
  return { success: false, code, error: code === "UNAVAILABLE"
    ? "Status belum dapat dipastikan. Periksa koneksi. Ulangi Stock In dengan kunci dan isian yang sama; muat ulang supplier sebelum mengubahnya."
    : code === "UNKNOWN_INGREDIENT_COST" ? "Biaya rata-rata stok lama belum diketahui. Selesaikan biaya awal bahan sebelum menerima stok tambahan."
    : "Permintaan ditolak. Periksa akses, supplier, bahan, satuan, jumlah, dan biaya." } as const;
}

export async function listSuppliersAction() {
  try { return { success: true, suppliers: await listSuppliers(prisma, await requireInventoryManager()) } as const; }
  catch (error) { return failure(error); }
}
export async function createSupplierAction(input: unknown) {
  try { return { success: true, supplier: await createSupplier(prisma, await requireInventoryManager(), input) } as const; }
  catch (error) { return failure(error); }
}
export async function updateSupplierAction(input: unknown) {
  try { return { success: true, supplier: await updateSupplier(prisma, await requireInventoryManager(), input) } as const; }
  catch (error) { return failure(error); }
}
export async function createStockInAction(input: unknown) {
  try { return { success: true, stockIn: await createStockIn(prisma, await requireInventoryManager(), input) } as const; }
  catch (error) { return failure(error); }
}
export async function getStockInAction(stockInId: unknown) {
  try { return { success: true, stockIn: await getStockIn(prisma, await requireInventoryManager(), stockInId) } as const; }
  catch (error) { return failure(error); }
}

export async function getRecipeHppAction(productId: unknown) {
  try { return { success: true, hpp: await getRecipeHpp(prisma, await requireRecipeReader(), productId) } as const; }
  catch (error) { return failure(error); }
}

export async function listIngredientsAction() {
  try { return { success: true, ingredients: await listIngredients(prisma, await requireInventoryManager()) } as const; }
  catch (error) { return failure(error); }
}
export async function listStockInsAction(input: unknown = {}) {
  try { return { success: true, ...await listStockIns(prisma, await requireInventoryManager(), input) } as const; }
  catch (error) { return failure(error); }
}
