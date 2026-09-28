// Browser-safe recovery contract. The server independently validates every field.
export type RecipeSubmission = {
  productId: string; expectedRevision: number | null; idempotencyKey: string;
  items: { ingredientId: string; quantity: string; unit: string }[];
};
export const recipeRecoveryKey = (actorId: string) => `aroom.recipe.pending.${actorId}`;
export type MenuDeleteSubmission = { productId: string; idempotencyKey: string };
export const menuDeleteRecoveryKey = (actorId: string) => `aroom.menu-delete.pending.${actorId}`;
export function restoreMenuDeleteSubmission(value: string): MenuDeleteSubmission {
  const raw = JSON.parse(value);
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)
    || Object.keys(raw).some(key => !["productId", "idempotencyKey"].includes(key))
    || typeof raw.productId !== "string" || !uuid.test(raw.productId)
    || typeof raw.idempotencyKey !== "string" || !uuid.test(raw.idempotencyKey)) throw new Error("Invalid recovery data");
  return { productId: raw.productId, idempotencyKey: raw.idempotencyKey };
}
export type MenuSubmission = {
  idempotencyKey: string; name: string; categoryId: string; price: number;
  items: RecipeSubmission["items"];
};
export type RecipeMutation = RecipeSubmission | MenuSubmission;
export function restoreMenuSubmission(value: string): MenuSubmission {
  const raw: MenuSubmission = JSON.parse(value);
  if (!raw || typeof raw.name !== "string" || !raw.name.trim() || raw.name.length > 128
    || typeof raw.price !== "number" || !Number.isInteger(raw.price) || raw.price <= 0 || raw.price > 2_147_483_647) {
    throw new Error("Invalid recovery data");
  }
  // Share canonical quantity validation without changing legacy save recovery.
  restoreRecipeSubmission(JSON.stringify({ productId: raw.categoryId, expectedRevision: null,
    idempotencyKey: raw.idempotencyKey, items: raw.items }));
  if (new Set(raw.items.map(item => item.ingredientId.toLowerCase())).size !== raw.items.length) throw new Error("Invalid recovery data");
  return raw;
}
export function restoreRecipeMutation(value: string): RecipeMutation {
  const raw = JSON.parse(value);
  return raw && "productId" in raw ? restoreRecipeSubmission(value) : restoreMenuSubmission(value);
}
export function restoreRecipeSubmission(value: string): RecipeSubmission {
  const raw: RecipeSubmission = JSON.parse(value);
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!raw || !uuid.test(raw.productId) || !uuid.test(raw.idempotencyKey)
    || (raw.expectedRevision !== null && (!Number.isInteger(raw.expectedRevision) || raw.expectedRevision < 1))
    || !Array.isArray(raw.items) || !raw.items.length || raw.items.length > 100
    || raw.items.some(item => !item || !uuid.test(item.ingredientId) || typeof item.quantity !== "string"
      || !/^\d{1,15}(\.\d{1,3})?$/.test(item.quantity) || !/[1-9]/.test(item.quantity)
      || !["g", "ml", "pcs"].includes(item.unit))) throw new Error("Invalid recovery data");
  return raw;
}
export function formatWac(value: string | null) {
  if (value === null) return "Belum diketahui";
  const padded = value.padStart(7, "0");
  const whole = padded.slice(0, -6).replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  const fraction = padded.slice(-6).replace(/0+$/, "");
  return `Rp${whole}${fraction ? `,${fraction}` : ""}`;
}
