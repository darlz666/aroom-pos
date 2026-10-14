import { isIP } from "node:net";
import { hostname, userInfo } from "node:os";
import { validatePassword } from "../password-validation";

export class EmergencyRecoveryError extends Error {
  constructor(public readonly code: "INVALID_INPUT" | "INVALID_TARGET" | "IDENTITY_MISMATCH" | "MIGRATIONS_REQUIRED" | "FORBIDDEN" | "STALE_VERSION" | "INTENT_CONFLICT") { super(code); }
}
export const recoveryPurpose = "REPLACE_EXISTING_ACTIVE_ADMIN_CREDENTIAL";
export function assertRecoveryInvocation(argv: string[], inputTTY: boolean | undefined, outputTTY: boolean | undefined, env: Record<string, string | undefined>) {
  // Driver debugging can log SQL arguments, including the new password hash.
  if (argv.length !== 2 || !inputTTY || !outputTTY || env.DEBUG || env.NODE_DEBUG) throw new EmergencyRecoveryError("INVALID_INPUT");
}
export function evidenceText(value: unknown, maximum = 256): string {
  if (typeof value !== "string" || !value.trim() || value !== value.trim() || value.length > maximum || /[\u0000-\u001f\u007f]/u.test(value)) throw new EmergencyRecoveryError("INVALID_INPUT");
  return value;
}
function uuid(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value)) throw new EmergencyRecoveryError("INVALID_INPUT");
  return value.toLowerCase();
}
export function recoveryIntent(input: unknown) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new EmergencyRecoveryError("INVALID_INPUT");
  const value = input as Record<string, unknown>;
  const keys = ["operationId", "targetUserId", "expectedVersion", "approvalReference", "operatorIdentity"];
  if (Object.keys(value).length !== keys.length || Object.keys(value).some(key => !keys.includes(key)) ||
      !Number.isInteger(value.expectedVersion) || (value.expectedVersion as number) < 1 || (value.expectedVersion as number) >= 2147483647) throw new EmergencyRecoveryError("INVALID_INPUT");
  return { operationId: uuid(value.operationId), targetUserId: uuid(value.targetUserId), expectedVersion: value.expectedVersion as number,
    approvalReference: evidenceText(value.approvalReference), operatorIdentity: evidenceText(value.operatorIdentity) };
}
export function validateRecoveryPassword(password: unknown, confirmation: unknown): string {
  if (!validatePassword(password) || Array.from(password).length < 20 || password !== confirmation) throw new EmergencyRecoveryError("INVALID_INPUT");
  return password;
}
export function recoveryEvidence(input: { osUsername: string; osUid: string; hostname: string }) {
  return { osUsername: evidenceText(input.osUsername, 255), osUid: evidenceText(input.osUid, 255), hostname: evidenceText(input.hostname, 255) };
}
export function verifiedHostEvidence(env: Record<string, string | undefined>) {
  const account = userInfo();
  const evidence = recoveryEvidence({ osUsername: account.username, osUid: String(account.uid), hostname: hostname() });
  if (evidence.osUsername !== env.RECOVERY_EXPECTED_OS_USERNAME || evidence.osUid !== env.RECOVERY_EXPECTED_OS_UID ||
      evidence.hostname !== env.RECOVERY_EXPECTED_HOSTNAME) throw new EmergencyRecoveryError("IDENTITY_MISMATCH");
  return evidence;
}
export function recoveryTarget(env: Record<string, string | undefined>) {
  try {
    // Explicit maintenance configuration only: never dotenv or DATABASE_URL.
    const url = new URL(env.RECOVERY_DATABASE_URL ?? "");
    const database = decodeURIComponent(url.pathname.slice(1)), user = decodeURIComponent(url.username);
    const port = url.port || "5432", host = url.hostname;
    const allowed = ["schema", "sslmode", "sslrootcert"];
    const serverAddress = env.RECOVERY_EXPECTED_SERVER_ADDRESS ?? "";
    if (!["postgres:", "postgresql:"].includes(url.protocol) || url.hash ||
        !/^(aroom_pos_operational_[a-z0-9_]+|aroom_access_test_[a-f0-9]{32})$/.test(database) ||
        !host || host.length > 255 || host !== env.RECOVERY_EXPECTED_HOST ||
        !/^[1-9][0-9]{0,4}$/.test(port) || Number(port) > 65535 || port !== env.RECOVERY_EXPECTED_PORT ||
        database !== env.RECOVERY_EXPECTED_DATABASE || !user || user.length > 255 || user !== env.RECOVERY_EXPECTED_USER ||
        env.RECOVERY_EXPECTED_SCHEMA !== "public" || !isIP(serverAddress) ||
        (url.searchParams.has("schema") && url.searchParams.get("schema") !== "public") ||
        [...url.searchParams.keys()].some(key => !allowed.includes(key) || url.searchParams.getAll(key).length !== 1)) throw new Error();
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(host);
    if (!local && (url.searchParams.get("sslmode") !== "verify-full" || !url.searchParams.get("sslrootcert"))) throw new Error();
    if (url.searchParams.has("sslmode") && !["disable", "verify-full"].includes(url.searchParams.get("sslmode")!)) throw new Error();
    return { connectionString: url.toString(), database, user, port: Number(port), host, schema: "public" as const, serverAddress };
  } catch { throw new EmergencyRecoveryError("INVALID_TARGET"); }
}
