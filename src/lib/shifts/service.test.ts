import assert from "node:assert/strict";
import { test } from "node:test";
import type { PrismaClient, Shift } from "../../generated/prisma/client";
import { withOperableShift } from "./service";

test("transaction locks before authorizing; callbacks receive only an operable shift", async () => {
  for (const status of ["OPEN", "CLOSED", null] as const) {
    const events: string[] = [];
    const shift = { id: "shift", cashierId: "owner", status };
    const tx = {
      $queryRaw: async (sql: TemplateStringsArray, id: string) => {
        assert.match(sql.join("?"), /WHERE "id" = \?::uuid FOR UPDATE/);
        assert.equal(id, "shift");
        events.push("lock");
        return status ? [shift] : [];
      },
    };
    const db = { $transaction: async (fn: (client: typeof tx) => Promise<unknown>, options: unknown) => {
      assert.deepEqual(options, { isolationLevel: "ReadCommitted" });
      return fn(tx);
    } } as unknown as PrismaClient;
    const result = withOperableShift(db, { id: "admin", role: "ADMIN" }, "shift", async (client, locked: Shift) => {
      assert.equal(client, tx);
      assert.equal(locked, shift);
      events.push("work");
      return 42;
    });
    if (status === "OPEN") {
      assert.equal(await result, 42);
      assert.deepEqual(events, ["lock", "work"]);
    } else {
      await assert.rejects(result, { code: "SHIFT_NOT_OPEN" });
      assert.deepEqual(events, ["lock"]);
    }
  }
});
