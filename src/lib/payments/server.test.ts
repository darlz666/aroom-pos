import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";

test("server boundary obtains a fresh requireOperator actor before every payment call", async () => {
  const require = createRequire(import.meta.url);
  const paths = [require.resolve("../auth/authorization"), require.resolve("../db"), require.resolve("./service")];
  const originals = paths.map(path => require.cache[path]);
  const events: string[] = [];
  const actor = { id: "server-user", role: "CASHIER" };
  let denied = false;
  const db = {};
  const exports = [
    { requireOperator: async () => { events.push("auth"); if (denied) throw new Error("unauthenticated"); return { ...actor }; } },
    { prisma: db },
    { recordManualPayment: async (client: unknown, authenticated: unknown, input: unknown) => {
      events.push("payment"); assert.equal(client, db); assert.deepEqual(authenticated, actor); return input;
    } },
  ];
  try {
    paths.forEach((path, i) => { require.cache[path] = { id: path, filename: path, loaded: true, exports: exports[i] } as NodeJS.Module; });
    const { confirmManualPayment } = await import("./server");
    const input = { actorId: "forged" };
    assert.equal(await confirmManualPayment(input), input);
    actor.id = "fresh-server-user";
    await confirmManualPayment(input);
    denied = true;
    await assert.rejects(confirmManualPayment(input), /unauthenticated/);
    assert.deepEqual(events, ["auth", "payment", "auth", "payment", "auth"]);
  } finally { paths.forEach((path, i) => { if (originals[i]) require.cache[path] = originals[i]; else delete require.cache[path]; }); }
});
