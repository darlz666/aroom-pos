/** Cup options are preparation snapshots only; they never change price or recipes. */
export type CupCustomization = {
  sugar: "NORMAL" | "LESS" | "NO_SUGAR";
  ice: "NORMAL" | "LESS" | "NO_ICE";
  cup: "REGULAR" | "LARGE";
  notes: string;
};

export function defaultCup(): CupCustomization {
  return { sugar: "NORMAL", ice: "NORMAL", cup: "REGULAR", notes: "" };
}

export class CustomizationError extends Error {
  constructor() { super("INVALID_CUSTOMIZATION"); this.name = "CustomizationError"; }
}

/** Single-line print text, with Unicode code-point limits and no malformed UTF-16. */
export function normalizeOptionalText(value: unknown, maximum: number): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || /[\u0000-\u001f\u007f-\u009f]/u.test(value)) throw new CustomizationError();
  for (const character of value) {
    const code = character.codePointAt(0)!;
    if (code >= 0xd800 && code <= 0xdfff) throw new CustomizationError();
  }
  const text = value.trim();
  if ([...text].length > maximum) throw new CustomizationError();
  return text || undefined;
}

export function normalizeCups(value: unknown, expectedQuantity?: number): CupCustomization[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 99 ||
      (expectedQuantity !== undefined && value.length !== expectedQuantity)) throw new CustomizationError();
  return Array.from(value, raw => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw) ||
        Object.keys(raw).some(key => !["sugar", "ice", "cup", "notes"].includes(key))) throw new CustomizationError();
    const entry = raw as Record<string, unknown>;
    if (!["NORMAL", "LESS", "NO_SUGAR"].includes(entry.sugar as string) ||
        !["NORMAL", "LESS", "NO_ICE"].includes(entry.ice as string) ||
        !["REGULAR", "LARGE"].includes(entry.cup as string) || typeof entry.notes !== "string") throw new CustomizationError();
    return { sugar: entry.sugar as CupCustomization["sugar"], ice: entry.ice as CupCustomization["ice"],
      cup: entry.cup as CupCustomization["cup"], notes: normalizeOptionalText(entry.notes, 300) ?? "" };
  });
}

/** Retain earlier unit choices when adjusting quantity; new cups receive fresh defaults. */
export function resizeCups(cups: readonly CupCustomization[], quantity: number): CupCustomization[] {
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 99) throw new CustomizationError();
  return Array.from({ length: quantity }, (_, index) => index < cups.length ? { ...cups[index] } : defaultCup());
}
