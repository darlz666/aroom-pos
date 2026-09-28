import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { InventoryError } from "./domain";

test("recipe actions independently authenticate reads/writes, preserve redirects and sanitize errors", async () => {
  const require = createRequire(import.meta.url);
  const paths = [require.resolve("../auth/authorization"), require.resolve("../db"), require.resolve("./recipe-service"), require.resolve("next/navigation"), require.resolve("next/cache")];
  const originals = paths.map(path => require.cache[path]);
  const db = {}, actor = { id: randomUUID(), role: "ADMIN" }, input = { actorId: "forged", total: 0 }, dto = { id: randomUUID() };
  let role = "ADMIN", failure: Error | undefined, calls = 0;
  const revalidated: string[] = [];
  try {
    const navigation = require("next/dist/client/components/navigation.react-server");
    const guard = (write: boolean) => async () => {
      if (!(write ? ["ADMIN", "STOCK_MANAGEMENT"] : ["ADMIN", "STOCK_MANAGEMENT", "FINANCE"]).includes(role)) navigation.redirect("/");
      return actor;
    };
    const service = (list = false) => async (client: unknown, user: unknown, raw?: unknown) => {
      calls++; assert.equal(client, db); assert.equal(user, actor); assert.equal(raw, list ? undefined : input);
      if (failure) throw failure;
      return dto;
    };
    const mocks = [{ requireRecipeReader: guard(false), requireInventoryManager: guard(true), requireRole: async (required: string) => {
      assert.equal(required, "ADMIN"); if (role !== "ADMIN") navigation.redirect("/"); return actor;
    } }, { prisma: db },
      { getRecipe: service(), listRecipeOptions: service(true), saveRecipe: service(), createMenu: service(), deleteMenu: service() }, navigation,
      { revalidatePath: (path: string) => revalidated.push(path) }];
    paths.forEach((path, i) => { require.cache[path] = { id: path, filename: path, loaded: true, exports: mocks[i] } as NodeJS.Module; });
    const actions = await import("./recipe-actions");
    for (role of ["ADMIN", "STOCK_MANAGEMENT", "FINANCE"]) {
      assert.deepEqual(await actions.listRecipeOptionsAction(), { success: true, ...dto });
      assert.deepEqual(await actions.getRecipeAction(input), { success: true, recipe: dto });
      if (role === "FINANCE") await assert.rejects(actions.saveRecipeAction(input), /NEXT_REDIRECT/);
      else assert.deepEqual(await actions.saveRecipeAction(input), { success: true, saved: dto });
      if (role === "ADMIN") {
        assert.deepEqual(await actions.createMenuAction(input), { success: true, created: dto });
        assert.deepEqual(revalidated, ["/recipes", "/pos"]);
        assert.deepEqual(await actions.deleteMenuAction(input), { success: true, deleted: dto });
        assert.deepEqual(revalidated, ["/recipes", "/pos", "/recipes", "/pos"]);
      } else {
        await assert.rejects(actions.createMenuAction(input), /NEXT_REDIRECT/);
        await assert.rejects(actions.deleteMenuAction(input), /NEXT_REDIRECT/);
      }
    }
    role = "ADMIN";
    for (const call of [() => actions.listRecipeOptionsAction(), () => actions.getRecipeAction(input), () => actions.saveRecipeAction(input), () => actions.createMenuAction(input), () => actions.deleteMenuAction(input)]) {
      failure = new InventoryError("STALE_RECIPE"); assert.deepEqual(await call(), { success: false, code: "STALE_RECIPE" });
      failure = new Error("secret connection details"); assert.deepEqual(await call(), { success: false, code: "UNAVAILABLE" });
      failure = undefined;
    }
    role = "CASHIER";
    const before = calls;
    await assert.rejects(actions.listRecipeOptionsAction(), /NEXT_REDIRECT/);
    await assert.rejects(actions.getRecipeAction(input), /NEXT_REDIRECT/);
    await assert.rejects(actions.saveRecipeAction(input), /NEXT_REDIRECT/);
    await assert.rejects(actions.createMenuAction(input), /NEXT_REDIRECT/);
    await assert.rejects(actions.deleteMenuAction(input), /NEXT_REDIRECT/);
    assert.equal(calls, before);
  } finally { paths.forEach((path, i) => { if (originals[i]) require.cache[path] = originals[i]; else delete require.cache[path]; }); }
});
