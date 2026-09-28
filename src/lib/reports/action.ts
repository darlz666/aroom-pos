"use server";

import { unstable_rethrow } from "next/navigation";
import { requireReportReader } from "../auth/authorization";
import { getReportReceipt } from "../orders/receipt";
import { prisma } from "../db";
import { ReportError } from "./domain";
import { getDailyReport } from "./service";

const messages = {
  FORBIDDEN: "Anda tidak memiliki akses laporan harian.",
  INVALID_DATE: "Pilih tanggal yang valid dalam format YYYY-MM-DD.",
  UNAVAILABLE: "Laporan belum dapat dimuat. Periksa koneksi lalu coba lagi.",
};

export async function getDailyReportAction(businessDate: unknown) {
  try {
    const actor = await requireReportReader();
    return { success: true, report: await getDailyReport(prisma, actor, businessDate) } as const;
  } catch (error) {
    unstable_rethrow(error);
    const code = error instanceof ReportError ? error.code : "UNAVAILABLE";
    return { success: false, code, error: messages[code] } as const;
  }
}

export async function getReportReceiptAction(orderId: unknown) {
  try {
    const actor = await requireReportReader();
    if (typeof orderId !== "string") return { success: false, error: "Pesanan tidak valid." } as const;
    return { success: true, receipt: await getReportReceipt(prisma, actor, orderId) } as const;
  } catch (error) {
    unstable_rethrow(error);
    return { success: false, error: "Struk belum dapat dimuat. Pastikan transaksi lunas dan periksa koneksi, lalu coba lagi." } as const;
  }
}
