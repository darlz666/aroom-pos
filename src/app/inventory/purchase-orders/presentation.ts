import type { inventoryPurchaseOrderDetailAction, inventoryPurchaseOrderReceiptsAction } from "@/lib/inventory-purchase-orders/actions";

export type Detail = Extract<Awaited<ReturnType<typeof inventoryPurchaseOrderDetailAction>>, { success: true }>["data"];
export type Receipts = Extract<Awaited<ReturnType<typeof inventoryPurchaseOrderReceiptsAction>>, { success: true }>["data"];
export type Masters = { suppliers: { id: string; name: string; active: boolean }[]; ingredients: { id: string; name: string; baseUnit: string; active: boolean; currentStock: string }[] };
export type Intent = { kind: "write" | "receive"; payload: Record<string, unknown> & { id: string; key: string; revision: number } };
export const labels = { DRAFT: "Draf", WAITING_APPROVAL: "Menunggu persetujuan", APPROVED: "Disetujui", REJECTED: "Ditolak", ORDERED: "Dipesan", PARTIALLY_RECEIVED: "Diterima sebagian", RECEIVED: "Diterima lengkap", CANCELLED: "Dibatalkan" };
export const operations: Record<string, string> = { CREATE: "Buat draf", EDIT: "Ubah draf", SUBMIT: "Ajukan persetujuan", APPROVE: "Setujui PO", REJECT: "Tolak PO", ORDER: "Tandai sudah dipesan", RECEIVE: "Terima barang" };
export const control = "min-h-12 min-w-0 max-w-full rounded-lg border border-[#a8aea0] bg-white px-3 py-3 text-base disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#465443]";
export const card = "min-w-0 space-y-4 rounded-xl border border-[#dce1d7] bg-white p-4 sm:p-6 [overflow-wrap:anywhere]";
export function money(value: string | number | null, micros = false) {
  if (value === null) return "Belum diketahui";
  const n = BigInt(value), negative = n < BigInt(0), abs = negative ? -n : n;
  const scale = micros ? BigInt(1000000) : BigInt(1);
  const fraction = micros ? (abs % scale).toString().padStart(6, "0").replace(/0+$/, "") : "";
  return `${negative ? "−" : ""}Rp${(abs / scale).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".")}${fraction ? `,${fraction}` : ""}`;
}
export const time = (value: string) => new Intl.DateTimeFormat("id-ID", { timeZone: "Asia/Jakarta", dateStyle: "medium", timeStyle: "short" }).format(new Date(value)) + " WIB";
export const units = (base: string) => base === "g" ? ["g", "kg"] : base === "ml" ? ["ml", "L"] : ["pcs"];
export function allowedOperations(role: string, actorId: string, detail: Detail) {
  if (role === "FINANCE" && detail.createdBy !== actorId && detail.status === "WAITING_APPROVAL") return ["APPROVE", "REJECT"];
  if (role === "STOCK_MANAGEMENT") return detail.status === "DRAFT" ? ["SUBMIT"] : detail.status === "APPROVED" ? ["ORDER"] : [];
  return [];
}
export const errors: Record<string, string> = {
  STALE_REVISION: "PO telah berubah. Data terbaru dimuat; periksa kembali sebelum mengirim permintaan baru.",
  VARIANCE_REASON_REQUIRED: "Harga aktual naik. Isi penjelasan pada setiap baris yang naik; persetujuan ulang Finance tidak diperlukan.",
  DUPLICATE_INGREDIENT: "Bahan duplikat atau nama usulan sudah ada. Pilih bahan yang sesuai secara eksplisit.",
  OVER_RECEIPT: "Jumlah penerimaan melebihi sisa pesanan. Muat ulang dan periksa jumlah.",
  UNKNOWN_INGREDIENT_COST: "Biaya stok lama belum diketahui. Selesaikan biaya awal bahan sebelum menerima stok tambahan.",
  FORBIDDEN: "Akses ditolak. Periksa peran dan status akun.",
};
