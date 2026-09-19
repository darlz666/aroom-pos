"use server";

import { unstable_rethrow } from "next/navigation";
import { requireInventoryManager, requireRecipeReader } from "../auth/authorization";
import { prisma } from "../db";
import { InventoryError } from "./domain";
import { getRecipe, listRecipeOptions, saveRecipe } from "./recipe-service";

function failure(error: unknown) {
  unstable_rethrow(error);
  return { success: false, code: error instanceof InventoryError ? error.code : "UNAVAILABLE" } as const;
}
export async function listRecipeOptionsAction() {
  try { return { success: true, ...await listRecipeOptions(prisma, await requireRecipeReader()) } as const; }
  catch (error) { return failure(error); }
}
export async function getRecipeAction(productId: unknown) {
  try { return { success: true, recipe: await getRecipe(prisma, await requireRecipeReader(), productId) } as const; }
  catch (error) { return failure(error); }
}
export async function saveRecipeAction(input: unknown) {
  try { return { success: true, saved: await saveRecipe(prisma, await requireInventoryManager(), input) } as const; }
  catch (error) { return failure(error); }
}
