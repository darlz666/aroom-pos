import type { getStockInAction, listIngredientsAction, listStockInsAction, listSuppliersAction } from "@/lib/inventory/actions";

type ReadResult<T> = Extract<T, { success: true }> | { success: false; code: string; error: string };
export type IngredientsResult = ReadResult<Awaited<ReturnType<typeof listIngredientsAction>>>;
export type SuppliersResult = ReadResult<Awaited<ReturnType<typeof listSuppliersAction>>>;
export type HistoryResult = ReadResult<Awaited<ReturnType<typeof listStockInsAction>>>;
export type IngredientRow = Extract<IngredientsResult, { success: true }>["ingredients"][number];
export type SupplierRow = Extract<SuppliersResult, { success: true }>["suppliers"][number];
export type StockInDetail = Extract<Awaited<ReturnType<typeof getStockInAction>>, { success: true }>["stockIn"];
export const control = "min-h-14 min-w-0 rounded-lg border border-[#a8aea0] px-4 py-3 focus-visible:outline-2 focus-visible:outline-offset-2 disabled:cursor-not-allowed disabled:opacity-50";
export const primary = `${control} bg-[#344631] font-semibold text-white`;
export const card = "rounded-2xl border border-[#dedfd5] bg-[#fffefa] p-5";
export const rupiah = (value: number) => `Rp${new Intl.NumberFormat("id-ID").format(value)}`;
export const dateTime = (value: string) => new Intl.DateTimeFormat("id-ID", { timeZone: "Asia/Jakarta", dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
// Format exact decimal strings without first converting large balances to Number.
export function quantity(value: string) {
  const [whole, fraction] = value.split(".");
  return whole.replace(/\B(?=(\d{3})+(?!\d))/g, ".") + (fraction ? `,${fraction}` : "");
}
export function jakartaInput(now = new Date()) {
  const parts = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Jakarta", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(now);
  const part = (type: string) => parts.find(p => p.type === type)!.value;
  return `${part("year")}-${part("month")}-${part("day")}T${part("hour")}:${part("minute")}`;
}
export const statusLabels = { EMPTY: "Habis", LOW: "Stok rendah", AVAILABLE: "Tersedia" };
export const readError = "Data belum dapat dimuat. Periksa koneksi atau akses Anda, lalu coba lagi.";
export function inputError(code: string) {
  const messages: Record<string, string> = {
    INVALID_INPUT: "Periksa isian: nama, waktu penerimaan, catatan, dan biaya harus valid.",
    INVALID_QUANTITY: "Jumlah harus positif, maksimal 3 angka desimal, dan tidak melebihi batas stok.",
    INVALID_COST: "Biaya wajib rupiah bulat per satuan dasar. Total baris harus rupiah bulat dan tidak melebihi Rp2.147.483.647.",
    INCOMPATIBLE_UNIT: "Satuan tidak sesuai dengan bahan yang dipilih.", INVALID_UNIT: "Pilih satuan yang tersedia.",
    DUPLICATE_INGREDIENT: "Setiap bahan hanya boleh muncul satu kali.", SUPPLIER_INACTIVE: "Supplier sudah nonaktif. Muat ulang pilihan.",
    INGREDIENT_INACTIVE: "Bahan sudah nonaktif. Muat ulang pilihan.", SUPPLIER_NOT_FOUND: "Supplier tidak ditemukan. Muat ulang pilihan.",
    INGREDIENT_NOT_FOUND: "Bahan tidak ditemukan. Muat ulang pilihan.", FORBIDDEN: "Akses Anda telah berubah. Masuk kembali dengan akun yang berwenang.",
    IDEMPOTENCY_CONFLICT: "Penerimaan ini perlu diperiksa di riwayat. Jangan kirim sebagai penerimaan baru.",
  };
  return messages[code] ?? "Permintaan ditolak. Periksa isian dan muat ulang data sebelum mencoba lagi.";
}
