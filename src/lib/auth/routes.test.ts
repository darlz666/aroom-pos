import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { test } from "node:test";

const source = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

test("protected pages guard on the server before rendering", () => {
  const root = source("../../app/page.tsx");
  const admin = source("../../app/admin/page.tsx");
  for (const page of [root, admin]) {
    assert.doesNotMatch(page, /["']use client["']/);
    assert.match(page, /import .* from "@\/lib\/auth\/authorization"/);
    assert.doesNotMatch(page, /user\.(id|loginIdentifier|passwordHash)/);
  }
  assert.match(root, /await requireUser\(\)[\s\S]*return \(/);
  assert.match(admin, /await requireRole\("ADMIN"\)[\s\S]*return \(/);
});

test("login redirects authenticated users on the server", () => {
  const login = source("../../app/login/page.tsx");
  assert.doesNotMatch(login, /["']use client["']/);
  assert.match(login, /import .*getCurrentUser.* from "@\/lib\/auth\/current-user"/);
  assert.match(login, /if \(await getCurrentUser\(\)\) redirect\("\/"\);[\s\S]*return \(/);
});

test("logout form invokes the existing action before redirecting, without a GET route", () => {
  const root = source("../../app/page.tsx");
  assert.match(root, /import .*logoutAction.* from "@\/lib\/auth\/actions"/);
  assert.match(root, /async function logout\(\)\s*\{\s*"use server";\s*await logoutAction\(\);\s*redirect\("\/login"\);/);
  assert.match(root, /<form action=\{logout\}>/);
  assert.match(root, /<button type="submit"/);
  assert.doesNotMatch(root, /method="get"|href=.*logout/i);
  assert.equal(existsSync(new URL("../../app/logout/route.ts", import.meta.url)), false);
  assert.equal(existsSync(new URL("../../app/api/logout/route.ts", import.meta.url)), false);
});
