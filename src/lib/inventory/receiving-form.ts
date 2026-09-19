// Browser form parsing only. The receiving service remains authoritative for
// references, conversions, costs and stock. No calculated totals are submitted.
export type ReceivingLine = { ingredientId: string; quantity: string; unit: string; unitCost: string };
export type ReceivingSubmission = { idempotencyKey: string; supplierId: string; receivedAt: string; notes: string;
  items: { ingredientId: string; quantity: string; unit: string; unitCost: number }[] };
export const compatibleUnits = (baseUnit: string) => baseUnit === "ml" ? ["ml", "L"] : baseUnit === "g" ? ["g", "kg"] : ["pcs"];

export function receivingSubmission(fields: { supplierId: string; receivedAt: string; notes: string; lines: ReceivingLine[] }, key: string): ReceivingSubmission {
  if (!fields.supplierId || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(fields.receivedAt) || !fields.lines.length) throw new Error("Pilih supplier, waktu penerimaan, dan minimal satu bahan.");
  const seen = new Set<string>();
  const items = fields.lines.map(line => {
    if (!line.ingredientId || seen.has(line.ingredientId)) throw new Error("Pilih bahan berbeda untuk setiap baris.");
    seen.add(line.ingredientId);
    const quantity = line.quantity.trim().replace(",", ".");
    if (!/^\d+(\.\d{1,3})?$/.test(quantity) || !/[1-9]/.test(quantity)) throw new Error("Jumlah harus positif. Gunakan maksimal 3 angka desimal tanpa pemisah ribuan.");
    if (!/^\d+$/.test(line.unitCost) || Number(line.unitCost) > 2_147_483_647) throw new Error("Isi biaya per satuan dasar dalam rupiah bulat, tanpa titik atau koma.");
    return { ingredientId: line.ingredientId, quantity, unit: line.unit, unitCost: Number(line.unitCost) };
  });
  return { idempotencyKey: key, supplierId: fields.supplierId, receivedAt: `${fields.receivedAt}:00+07:00`, notes: fields.notes, items };
}

/** Recovery data is untrusted input and is always revalidated by the server. */
export function restoreSubmission(text: string): ReceivingSubmission {
  const raw: unknown = JSON.parse(text);
  if (!raw || typeof raw !== "object") throw new Error("Invalid recovery");
  const value = raw as ReceivingSubmission;
  if (typeof value.idempotencyKey !== "string" || typeof value.supplierId !== "string" || typeof value.receivedAt !== "string" || typeof value.notes !== "string" ||
    !Array.isArray(value.items) || value.items.length < 1 || value.items.length > 100 || !value.items.every(item => item && typeof item.ingredientId === "string" && typeof item.quantity === "string" && typeof item.unit === "string" && Number.isInteger(item.unitCost))) throw new Error("Invalid recovery");
  // Strip unrelated fields; actor and totals are never accepted from storage.
  return { idempotencyKey: value.idempotencyKey, supplierId: value.supplierId, receivedAt: value.receivedAt, notes: value.notes,
    items: value.items.map(item => ({ ingredientId: item.ingredientId, quantity: item.quantity, unit: item.unit, unitCost: item.unitCost })) };
}
