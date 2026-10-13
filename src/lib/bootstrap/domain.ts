import { normalizeLoginIdentifier } from "../auth/login-identifier";
import { validatePassword } from "../auth/password-validation";

export class BootstrapError extends Error {
  constructor(public readonly code: "INVALID_INPUT" | "INVALID_TARGET" | "IDENTITY_MISMATCH" | "MIGRATIONS_REQUIRED" | "DATABASE_NOT_EMPTY") { super(code); }
}
export function bootstrapInput(name: string, login: string, password: string, confirmation: string) {
  if (!name.trim() || name.length > 128 || !normalizeLoginIdentifier(login) || login.length > 128 ||
      password !== confirmation || !validatePassword(password) || Array.from(password).length < 20 ||
      password.trim() !== password || new Set(password).size < 8) throw new BootstrapError("INVALID_INPUT");
  return { name: name.trim(), loginIdentifier: normalizeLoginIdentifier(login), password };
}
export function bootstrapTarget(env: Record<string, string | undefined>) {
  try {
    // Deliberately do not read DATABASE_URL or load dotenv.
    const url = new URL(env.BOOTSTRAP_DATABASE_URL ?? "");
    const database = decodeURIComponent(url.pathname.slice(1));
    const user = decodeURIComponent(url.username);
    const port = url.port || "5432";
    if (!["postgres:", "postgresql:"].includes(url.protocol) || url.hash ||
        !/^(aroom_pos_operational_[a-z0-9_]+|aroom_bootstrap_test_[a-f0-9]{32})$/.test(database) ||
        !user || !url.hostname || url.hostname !== env.BOOTSTRAP_EXPECTED_HOST || port !== env.BOOTSTRAP_EXPECTED_PORT ||
        database !== env.BOOTSTRAP_EXPECTED_DATABASE || user !== env.BOOTSTRAP_EXPECTED_USER ||
        (url.searchParams.has("schema") && url.searchParams.get("schema") !== "public") ||
        [...url.searchParams.keys()].some(key => !["sslmode", "sslrootcert", "schema"].includes(key))) throw new Error();
    return { connectionString: url.toString(), database, user, port: Number(port), host: url.hostname };
  } catch { throw new BootstrapError("INVALID_TARGET"); }
}
