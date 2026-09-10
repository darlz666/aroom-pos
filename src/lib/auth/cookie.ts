export const SESSION_COOKIE_NAME = "aroom_session";
export const SESSION_LIFETIME_SECONDS = 12 * 60 * 60;

export function getSessionCookieOptions() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_LIFETIME_SECONDS,
  } as const;
}
