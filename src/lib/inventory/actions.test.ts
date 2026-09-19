import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { InventoryError } from "./domain";

test("inventory actions authenticate, pass only session actor and return safe uncertain outcomes", async () => {
  const require = createRequire(import.meta.url);
  const paths = [require.resolve("../auth/authorization"), require.resolve("../db"), require.resolve("./service"), require.resolve("next/navigation")];
  const originals = paths.map(path => require.cache[path]);
  let actor = { id: randomUUID(), role: "STOCK_MANAGEMENT" };
  const db = {}, dto = { id: randomUUID() }, input = { actorId: "untrusted" };
  let failure: Error | undefined, denied = false, calls = 0;
  const service = (list = false) => async (client: unknown, authenticated: unknown, raw?: unknown) => {
    assert.equal(client, db); assert.equal(authenticated, actor); assert.equal(raw, list ? undefined : input); calls++;
    if (failure) throw failure;
    return list ? [dto] : dto;
  };
  try {
    const navigation = require("next/dist/client/components/navigation.react-server");
    const guard = async () => { if (denied) navigation.redirect("/login"); return actor; };
    const mocks = [{ requireInventoryManager: guard, requireRecipeReader: guard }, { prisma: db },
      { listSuppliers: service(true), listIngredients: service(true), listStockIns: service(), createSupplier: service(), updateSupplier: service(), createStockIn: service(), getStockIn: service(), getRecipeHpp: service() }, navigation];
    paths.forEach((path, i) => { require.cache[path] = { id: path, filename: path, loaded: true, exports: mocks[i] } as NodeJS.Module; });
    const actions = await import("./actions");
    for (const role of ["ADMIN", "STOCK_MANAGEMENT"]) {
      actor = { id: randomUUID(), role };
      assert.deepEqual(await actions.listSuppliersAction(), { success: true, suppliers: [dto] });
      assert.deepEqual(await actions.listIngredientsAction(), { success: true, ingredients: [dto] });
      assert.deepEqual(await actions.listStockInsAction(input), { success: true, ...dto });
      for (const [action, key] of [[actions.createSupplierAction, "supplier"], [actions.updateSupplierAction, "supplier"],
        [actions.createStockInAction, "stockIn"], [actions.getStockInAction, "stockIn"], [actions.getRecipeHppAction, "hpp"]] as const) {
        assert.deepEqual(await action(input), { success: true, [key]: dto });
        failure = new InventoryError("IDEMPOTENCY_CONFLICT");
        assert.equal((await action(input)).success, false);
        failure = new Error("private connection string");
        const result = await action(input);
        assert.equal(result.success, false);
        if (!result.success) assert.equal(result.code, "UNAVAILABLE");
        assert.doesNotMatch(JSON.stringify(result), /private connection string/);
        failure = undefined;
      }
    }
    denied = true;
    const before = calls;
    for (const call of [() => actions.listSuppliersAction(), () => actions.createSupplierAction(input), () => actions.updateSupplierAction(input),
      () => actions.createStockInAction(input), () => actions.getStockInAction(input), () => actions.getRecipeHppAction(input), () => actions.listIngredientsAction(), () => actions.listStockInsAction(input)]) {
      await assert.rejects(call(), (error: unknown) => (error as { digest: string }).digest === "NEXT_REDIRECT;replace;/login;307;");
    }
    assert.equal(calls, before);
  } finally { paths.forEach((path, i) => { if (originals[i]) require.cache[path] = originals[i]; else delete require.cache[path]; }); }
});
