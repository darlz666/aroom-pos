export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 128;

// Count Unicode code points; never trim or otherwise transform passwords.
export function validatePassword(password: string): boolean {
  const length = Array.from(password).length;
  return length >= PASSWORD_MIN_LENGTH && length <= PASSWORD_MAX_LENGTH;
}
