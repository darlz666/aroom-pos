import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { test } from "node:test";
import type { AuthenticatedUser } from "./credentials";

test("every action rejects restricted roles and revoked sessions before service/database work", async () => {
  const require = createRequire(import.meta.url);
  const paths = [require.resolve("./current-user"), require.resolve("../db"), require.resolve("next/navigation")];
  const originals = paths.map(path => require.cache[path]);
  let user: AuthenticatedUser | null = { id: randomUUID(), name: "Staff", loginIdentifier: "staff", role: "FINANCE" };
  let reads = 0;
  const trap = new Proxy({}, { get() { reads++; throw new Error("Unauthorized database access"); } });
  try {
    const mocks = [{ getCurrentUser: async () => user }, { prisma: trap }, require("next/dist/client/components/navigation.react-server")];
    paths.forEach((path, i) => { require.cache[path] = { id: path, filename: path, loaded: true, exports: mocks[i] } as NodeJS.Module; });
    const users = await import("../users/actions");
    const orders = await import("../orders/actions");
    const shifts = await import("../shifts/actions");
    const { closeShiftAction } = await import("../shifts/close-action");
    const settlement = await import("../shifts/settlement-action");
    const { submitPaymentAction } = await import("../../app/pos/payment-action");
    const { getDailyReportAction } = await import("../reports/action");
    const adminCalls = [() => users.listUsersAction(), () => users.createUserAction({ role: "ADMIN" }),
      () => users.changeUserRoleAction({}), () => users.setUserActiveAction({}), () => getDailyReportAction("2026-09-18")];
    const operationalCalls = [() => orders.createOrderAction({}), () => orders.editOrderAction({}),
      () => orders.cancelOrderAction({}), () => orders.listActiveUnpaidOrdersAction(),
      () => orders.getActiveUnpaidOrderAction(randomUUID()), () => orders.getReceiptAction(randomUUID()),
      () => orders.listOrderHistoryAction({}), () => orders.getHistoricalOrderAction(randomUUID()),
      () => shifts.openShiftAction(0), () => shifts.getActiveShiftAction(),
      () => closeShiftAction({ shiftId: randomUUID(), countedCash: "0", discrepancyNote: "", adminCloseReason: "" }),
      () => settlement.getShiftSettlementAction(randomUUID()), () => submitPaymentAction({})];
    for (const role of ["CASHIER", "STOCK_MANAGEMENT", "FINANCE", null] as const) {
      user = role ? { id: randomUUID(), name: "Staff", loginIdentifier: "staff", role } : null;
      for (const call of [...adminCalls, ...(role !== "CASHIER" ? operationalCalls : [])]) {
        await assert.rejects(call(), (error: unknown) => {
          assert.equal((error as { digest: string }).digest, `NEXT_REDIRECT;replace;${role ? "/" : "/login"};307;`);
          return true;
        });
      }
    }
    assert.equal(reads, 0);
  } finally {
    paths.forEach((path, i) => { if (originals[i]) require.cache[path] = originals[i]; else delete require.cache[path]; });
  }
});
