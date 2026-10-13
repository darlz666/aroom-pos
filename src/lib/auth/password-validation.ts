export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 128;

// Count Unicode code points; never trim or otherwise transform passwords.
export function validatePassword(password: unknown): password is string {
  if (typeof password !== "string" || password.length > 256 || !password.trim() || /[\uD800-\uDFFF]/u.test(password)) return false;
  const length = Array.from(password).length;
  return length >= PASSWORD_MIN_LENGTH && length <= PASSWORD_MAX_LENGTH;
}
