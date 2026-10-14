import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const checksum = "29ce82aa582156d61282f64f4b5e89c8619ccbebd879b5a016cf6dddd2ad81c0";
const localCandidates = ["aroompassword", "aroomcoffee123", "aroomcoffeebar", "password123!", "password1234", "adminadminadmin", "masuk123!", "changeme12345"];
// Comparison only; accepted password bytes are never transformed before hashing.
const comparison = (value: string) => value.normalize("NFC").toLowerCase();
export class PasswordScreeningError extends Error {
  constructor(public readonly code: "COMMON_PASSWORD" | "SCREENING_UNAVAILABLE") { super(code); }
}
export function loadPasswordBlocklist(bytes: Buffer): ReadonlySet<string> {
  // Git may check text out with CRLF on Windows; canonical corpus checksum is LF.
  const text = bytes.toString("utf8").replaceAll("\r\n", "\n");
  if (createHash("sha256").update(text).digest("hex") !== checksum) throw new PasswordScreeningError("SCREENING_UNAVAILABLE");
  return new Set([...bytes.toString("utf8").split(/\r?\n/).filter(Boolean), ...localCandidates].map(comparison));
}
let blocklist: ReadonlySet<string> | undefined;
export function screenNewPassword(password: string): void {
  if (!blocklist) {
    try { blocklist = loadPasswordBlocklist(readFileSync(join(process.cwd(), "src/lib/auth/password-blocklist.txt"))); }
    catch { throw new PasswordScreeningError("SCREENING_UNAVAILABLE"); }
  }
  if (blocklist.has(comparison(password))) throw new PasswordScreeningError("COMMON_PASSWORD");
}
export function generateTemporaryPassword(): string {
  for (let attempt = 0; attempt < 5; attempt++) {
    const candidate = randomBytes(24).toString("base64url");
    try { screenNewPassword(candidate); return candidate; }
    catch (error) { if (!(error instanceof PasswordScreeningError) || error.code !== "COMMON_PASSWORD") throw error; }
  }
  throw new PasswordScreeningError("SCREENING_UNAVAILABLE");
}
