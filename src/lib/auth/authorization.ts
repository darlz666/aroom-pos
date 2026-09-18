import "server-only";

import { redirect } from "next/navigation";
import type { AuthenticatedUser } from "./credentials";
import { getCurrentUser } from "./current-user";

// Each protected server page and future sensitive Server Action must call its
// own guard. A page guard does not authorize actions invoked independently.
export async function requireUser(): Promise<AuthenticatedUser> {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  return user;
}

export async function requireRole(role: AuthenticatedUser["role"]): Promise<AuthenticatedUser> {
  const user = await requireUser();
  if (user.role !== role) redirect("/");
  return user;
}

export async function requireOperator(): Promise<AuthenticatedUser> {
  const user = await requireUser();
  if (user.role !== "ADMIN" && user.role !== "CASHIER") redirect("/");
  return user;
}
