// Browser-safe recovery contract. The server independently validates every field.
export type RecipeSubmission = {
  productId: string; expectedRevision: number | null; idempotencyKey: string;
  items: { ingredientId: string; quantity: string; unit: string }[];
};
export const recipeRecoveryKey = (actorId: string) => `aroom.recipe.pending.${actorId}`;
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
