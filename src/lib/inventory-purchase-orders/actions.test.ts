import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { InventoryPurchaseOrderError } from "./domain";

test("PO actions authenticate each request, preserve redirects and hide unexpected errors", async () => {
  const require = createRequire(import.meta.url);
  const paths = [require.resolve("../auth/authorization"), require.resolve("../db"), require.resolve("./service"), require.resolve("next/navigation"), require.resolve("./receiving-service")];
  const originals = paths.map(path => require.cache[path]);
  const actor = { id: randomUUID(), role: "STOCK_MANAGEMENT" }, db = {}, input = { id: randomUUID() };
  let failure: Error | undefined, denied = false, calls = 0, guards = 0;
  const service = async (client: unknown, user: unknown, raw: unknown) => {
    calls++; assert.equal(client, db); assert.equal(user, actor); assert.equal(raw, input);
    if (failure) throw failure;
    return { id: input.id };
  };
  try {
    const navigation = require("next/dist/client/components/navigation.react-server");
    const mocks = [{ requireUser: async () => { guards++; if (denied) navigation.redirect("/login"); return actor; } }, { prisma: db },
      { saveInventoryPurchaseOrder: service, listInventoryPurchaseOrders: service, getInventoryPurchaseOrder: service, readInventoryPurchaseOrderHistory: service }, navigation,
      { receiveInventoryPurchaseOrder: service, readInventoryPurchaseOrderReceipts: service }];
    paths.forEach((path, i) => { require.cache[path] = { id: path, filename: path, loaded: true, exports: mocks[i] } as NodeJS.Module; });
    const actions = await import("./actions");
    for (const action of [actions.inventoryPurchaseOrderWriteAction, actions.inventoryPurchaseOrderListAction, actions.inventoryPurchaseOrderDetailAction, actions.inventoryPurchaseOrderHistoryAction,
      actions.inventoryPurchaseOrderReceiveAction, actions.inventoryPurchaseOrderReceiptsAction]) {
      assert.deepEqual(await action(input), { success: true, data: { id: input.id } });
      failure = new InventoryPurchaseOrderError("FORBIDDEN");
      const invalid = await action(input);
      assert.equal(invalid.success, false);
      if (!invalid.success) { assert.equal(invalid.code, "FORBIDDEN"); assert.equal(invalid.retryable, false); }
      failure = new Error("private database credentials");
      const unavailable = await action(input);
      assert.equal(unavailable.success, false);
      if (!unavailable.success) { assert.equal(unavailable.code, "UNAVAILABLE"); assert.equal(unavailable.retryable, true); assert.ok(!unavailable.error.includes("credentials")); }
      failure = undefined; denied = true;
      const before = calls;
      await assert.rejects(action(input), /NEXT_REDIRECT/);
      assert.equal(calls, before); denied = false;
    }
    assert.equal(guards, 24);
  } finally {
    paths.forEach((path, i) => { if (originals[i]) require.cache[path] = originals[i]; else delete require.cache[path]; });
  }
});
