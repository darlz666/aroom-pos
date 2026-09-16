"use server";

import { unstable_rethrow } from "next/navigation";
import { confirmManualPayment } from "@/lib/payments/server";
import { PaymentError } from "@/lib/payments/domain";

// UI transport only: authentication, validation and finalization stay in the boundary.
export async function submitPaymentAction(input: unknown) {
  try {
    return { success: true, payment: await confirmManualPayment(input) } as const;
  } catch (error) {
    unstable_rethrow(error);
    return { success: false, code: error instanceof PaymentError ? error.code : "PAYMENT_FAILED" } as const;
  }
}
