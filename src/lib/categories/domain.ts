export class CategoryError extends Error {
  constructor(public readonly code: "FORBIDDEN" | "INVALID_INPUT" | "DUPLICATE_NAME" | "NOT_FOUND" | "STALE_REVISION" | "IDEMPOTENCY_CONFLICT") { super(code); }
}
export type CategoryRow = { id: string; name: string; displayOrder: number; active: boolean; revision: number };
export type CategoryRequest = { key: string; id: string | null; expectedRevision: number | null; name: string; displayOrder: number; active: boolean };
export function categoryId(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) throw new CategoryError("INVALID_INPUT");
  return value.toLowerCase();
}
export function categoryInput(input: unknown): CategoryRequest {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new CategoryError("INVALID_INPUT");
  const raw = input as Record<string, unknown>;
  if (Object.keys(raw).some(key => !["key", "id", "expectedRevision", "name", "displayOrder", "active"].includes(key)) ||
      typeof raw.name !== "string" || !raw.name.trim() || raw.name.length > 128 || /[\p{Cc}\p{Cf}]/u.test(raw.name) ||
      typeof raw.displayOrder !== "number" || !Number.isInteger(raw.displayOrder) || raw.displayOrder < 0 || raw.displayOrder > 2147483647 ||
      typeof raw.active !== "boolean" || (raw.id === null ? raw.expectedRevision !== null :
        typeof raw.expectedRevision !== "number" || !Number.isInteger(raw.expectedRevision) || raw.expectedRevision < 1 || raw.expectedRevision >= 2147483647)) {
    throw new CategoryError("INVALID_INPUT");
  }
  return { key: categoryId(raw.key), id: raw.id === null ? null : categoryId(raw.id), expectedRevision: raw.expectedRevision as number | null,
    name: raw.name.trim(), displayOrder: raw.displayOrder, active: raw.active };
}
