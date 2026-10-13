"use server";
import { unstable_rethrow } from "next/navigation";
import { requireRole } from "../auth/authorization";
import { prisma } from "../db";
import { CategoryError } from "./domain";
import { categoryHistory, listCategories, saveCategory } from "./service";

function failure(error: unknown) {
  unstable_rethrow(error);
  return { success: false, code: error instanceof CategoryError ? error.code : "UNAVAILABLE" } as const;
}
export async function listCategoriesAction() {
  try { return { success: true, categories: await listCategories(prisma, await requireRole("ADMIN")) } as const; }
  catch (error) { return failure(error); }
}
export async function saveCategoryAction(input: unknown) {
  try { return { success: true, ...await saveCategory(prisma, await requireRole("ADMIN"), input) } as const; }
  catch (error) { return failure(error); }
}
export async function categoryHistoryAction(id: unknown) {
  try {
    const rows = await categoryHistory(prisma, await requireRole("ADMIN"), id);
    return { success: true, events: rows.map(row => {
      const details = row.details as { before?: unknown; after?: unknown } | null;
      return { id: row.id, action: row.action, actorId: row.actorId, createdAt: row.createdAt.toISOString(), before: details?.before, after: details?.after };
    }) } as const;
  } catch (error) { return failure(error); }
}
