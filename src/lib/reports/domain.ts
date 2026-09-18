export class ReportError extends Error {
  constructor(public readonly code: "FORBIDDEN" | "INVALID_DATE" | "UNAVAILABLE") {
    super(code);
  }
}

/** Jakarta business dates use WIB (UTC+07:00), independent of the host timezone. */
export function businessDateRange(input: unknown) {
  if (typeof input !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(input) || input.startsWith("0000")) {
    throw new ReportError("INVALID_DATE");
  }
  const calendar = new Date(`${input}T00:00:00.000Z`);
  if (!Number.isFinite(calendar.getTime()) || calendar.toISOString().slice(0, 10) !== input) {
    throw new ReportError("INVALID_DATE");
  }
  const start = new Date(`${input}T00:00:00.000+07:00`);
  return { businessDate: input, start, end: new Date(start.getTime() + 86_400_000) };
}

export function jakartaBusinessDate(now = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Jakarta", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(now);
  const part = (name: string) => parts.find(p => p.type === name)!.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}
