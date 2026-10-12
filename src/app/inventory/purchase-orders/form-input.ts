import type { Detail, Intent } from "./presentation";

// Browser input checks only. Services independently validate all submitted data.
// Never import the Prisma-backed domain validators into a browser bundle.
function invalid(code = "INVALID_INPUT"): never { throw Object.assign(new Error(code), { code }); }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}
function id(value: unknown) { if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) invalid(); }
function amount(value: unknown) { if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > 2147483647) invalid(); return BigInt(value); }
function quantity(value: unknown) {
  if (typeof value !== "string" || !/^\d{1,15}(\.\d{1,3})?$/.test(value)) invalid();
  const [whole, fraction = ""] = value.split(".");
  const q = BigInt(whole) * BigInt(1000) + BigInt(fraction.padEnd(3, "0"));
  if (q <= BigInt(0)) invalid();
  return q;
}
function unit(value: unknown) { if (!["g", "kg", "ml", "L", "pcs"].includes(value as string)) invalid(); }
function note(value: unknown, max: number, required = false) {
  if (value === undefined || value === null) { if (required) invalid(); return; }
  if (typeof value !== "string" || value.length > max || (required && !value.trim()) || /[\u0000-\u001f]/.test(value)) invalid();
}
export function validateIntent(value: unknown): asserts value is Intent {
  const envelope = object(value), r = object(envelope.payload);
  if (envelope.kind !== "write" && envelope.kind !== "receive") invalid();
  id(r.id); id(r.key); amount(r.revision);
  if (r.revision === 2147483647) invalid();
  let lines: unknown;
  if (envelope.kind === "write") {
    if (!["CREATE", "EDIT", "SUBMIT", "APPROVE", "REJECT", "ORDER"].includes(r.operation as string)) invalid();
    if (r.operation === "CREATE" ? r.revision !== 0 : Number(r.revision) < 1) invalid();
    if (r.operation === "CREATE" || r.operation === "EDIT") { const d = object(r.data); id(d.supplierId); note(d.notes, 2000); lines = d.lines; }
    else { note(r.note, 2000, r.operation === "REJECT"); return; }
  } else {
    if (Number(r.revision) < 1 || typeof r.receivedAt !== "string" || !/(Z|[+-]\d{2}:\d{2})$/.test(r.receivedAt) || !Number.isFinite(Date.parse(r.receivedAt))) invalid();
    note(r.notes, 1000); lines = r.lines;
  }
  if (!Array.isArray(lines) || !lines.length || lines.length > 100) invalid();
  const seen = new Set<unknown>(); let total = BigInt(0);
  for (const raw of lines) {
    const l = object(raw), receive = envelope.kind === "receive", lineId = receive ? l.lineId : l.id;
    id(lineId); if (seen.has(lineId)) invalid(); seen.add(lineId);
    const q = quantity(receive ? l.quantity : l.purchaseQuantity), price = amount(receive ? l.purchaseUnitCost : l.estimatedUnitPrice);
    unit(receive ? l.unit : l.purchaseUnit);
    if (q * price % BigInt(1000) !== BigInt(0)) invalid();
    total += q * price / BigInt(1000);
    if (total > BigInt(2147483647)) invalid();
    if (receive) {
      note(l.varianceReason, 2000);
      if (l.resolution !== undefined) { const resolution = object(l.resolution); if (resolution.type === "EXISTING") id(resolution.ingredientId); else if (resolution.type !== "CREATE") invalid(); }
    } else if (l.ingredientId !== undefined) { id(l.ingredientId); if (l.proposedIngredient !== undefined) invalid(); }
    else { const proposal = object(l.proposedIngredient); note(proposal.name, 128, true); if (!["g", "ml", "pcs"].includes(proposal.baseUnit as string)) invalid(); }
  }
}
export function priceIncreased(price: string, unit: string, approved: Pick<Detail["lines"][number], "estimatedUnitPrice" | "purchaseUnit">) {
  if (!/^\d+$/.test(price)) return false;
  const factor = (u: string) => BigInt(u === "kg" || u === "L" ? 1000 : 1);
  return BigInt(price) * factor(approved.purchaseUnit) > BigInt(approved.estimatedUnitPrice) * factor(unit);
}
export function validateVariance(intent: Intent, detail: Detail) {
  if (intent.kind !== "receive") return;
  for (const raw of intent.payload.lines as Record<string, unknown>[]) {
    const approved = detail.lines.find(l => l.id === raw.lineId);
    if (approved && priceIncreased(String(raw.purchaseUnitCost), String(raw.unit), approved) && !String(raw.varianceReason ?? "").trim()) invalid("VARIANCE_REASON_REQUIRED");
  }
}
