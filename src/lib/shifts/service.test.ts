import assert from "node:assert/strict";
import { test } from "node:test";
import type { PrismaClient, Shift } from "../../generated/prisma/client";
import { openShift, withOperableShift } from "./service";

test("an occupied register blocks another CASHIER and ADMIN without any write", async () => {
  const shift = { id: "shift", cashierId: "owner", status: "OPEN", openingCash: 100000 } as Shift;
  let transactions = 0;
  const db = { $transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
    transactions++;
    return fn({ shift: { findFirst: async () => shift } });
  } } as unknown as PrismaClient;
  for (const role of ["CASHIER", "ADMIN"] as const) {
    await assert.rejects(openShift(db, { id: "another", role }, 0), { code: "REGISTER_OCCUPIED" });
  }
  const result = await openShift(db, { id: "owner", role: "CASHIER" }, 1);
  assert.equal(result.state, "EXISTING");
  assert.equal(result.shift.openingCash, 100000);
  assert.equal(transactions, 3);
});

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
