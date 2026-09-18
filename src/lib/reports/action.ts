"use server";

import { unstable_rethrow } from "next/navigation";
import { requireRole } from "../auth/authorization";
import { prisma } from "../db";
import { ReportError } from "./domain";
import { getDailyReport } from "./service";

const messages = {
  FORBIDDEN: "Laporan harian hanya tersedia untuk Admin.",
  INVALID_DATE: "Pilih tanggal yang valid dalam format YYYY-MM-DD.",
  UNAVAILABLE: "Laporan belum dapat dimuat. Periksa koneksi lalu coba lagi.",
};

export async function getDailyReportAction(businessDate: unknown) {
  try {
    const actor = await requireRole("ADMIN");
    return { success: true, report: await getDailyReport(prisma, actor, businessDate) } as const;
  } catch (error) {
    unstable_rethrow(error);
    const code = error instanceof ReportError ? error.code : "UNAVAILABLE";
    return { success: false, code, error: messages[code] } as const;
  }
}
