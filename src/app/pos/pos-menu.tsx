"use client";

import { useState } from "react";

type MenuProduct = { id: string; name: string; price: number; available: boolean };
export type MenuCategory = { id: string; name: string; products: MenuProduct[] };
type CartLine = { product: MenuProduct; quantity: number };
const rupiah = (value: number) => `Rp${new Intl.NumberFormat("id-ID").format(value)}`;
const control = "min-h-12 min-w-12 rounded-lg border border-[#a8aea0] px-3 font-semibold hover:bg-[#e9eade] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#3e503c] disabled:cursor-not-allowed disabled:opacity-40";

export function PosMenu({ categories }: { categories: MenuCategory[] }) {
  const [categoryId, setCategoryId] = useState<string | null>(null);
  const [cart, setCart] = useState<CartLine[]>([]);
  const [orderType, setOrderType] = useState<"DINE_IN" | "TAKEAWAY">("DINE_IN");
  const visibleCategories = categories.filter(category => categoryId === null || category.id === categoryId);
  const count = cart.reduce((sum, line) => sum + line.quantity, 0);
  // Local preview only. Future order creation must use server-authoritative totals.
  const total = cart.reduce((sum, line) => sum + line.product.price * line.quantity, 0);

  function add(product: MenuProduct) {
    if (!product.available) return;
    setCart(current => {
      const existing = current.find(line => line.product.id === product.id);
      if (existing) return current.map(line => line.product.id === product.id ? { ...line, quantity: Math.min(99, line.quantity + 1) } : line);
      return [...current, { product, quantity: 1 }];
    });
  }

  function adjust(id: string, delta: number) {
    setCart(current => current.map(line => line.product.id === id ? { ...line, quantity: Math.max(1, Math.min(99, line.quantity + delta)) } : line));
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col lg:grid lg:grid-cols-[minmax(0,1fr)_minmax(20rem,0.65fr)]">
      <section aria-label="Menu" className="min-h-0 min-w-0 lg:flex lg:flex-col">
        <nav aria-label="Kategori menu" className="flex shrink-0 gap-2 overflow-x-auto border-b border-[#dedfd5] p-4">
          {[{ id: null, name: "Semua" }, ...categories].map(category => (
            <button key={category.id ?? "all"} type="button" aria-pressed={categoryId === category.id} onClick={() => setCategoryId(category.id)} className={`${control} shrink-0 ${categoryId === category.id ? "bg-[#344631] text-white hover:bg-[#293926]" : "bg-[#fffefa]"}`}>{category.name}</button>
          ))}
        </nav>
        <div className="p-4 lg:min-h-0 lg:flex-1 lg:overflow-y-auto">
          {visibleCategories.every(category => category.products.length === 0) && <p className="py-10 text-center text-[#62685c]">Belum ada produk dalam kategori ini.</p>}
          {visibleCategories.filter(category => category.products.length > 0).map(category => (
            <section key={category.id} aria-labelledby={`category-${category.id}`} className="mb-6">
              <h2 id={`category-${category.id}`} className="mb-3 text-lg font-semibold">{category.name}</h2>
              <div className="grid grid-cols-2 gap-3 xl:grid-cols-3">
                {category.products.map(product => {
                  const quantity = cart.find(line => line.product.id === product.id)?.quantity ?? 0;
                  return <button key={product.id} type="button" disabled={!product.available || quantity >= 99} onClick={() => add(product)} aria-label={`Tambah ${product.name}`} className="flex min-h-36 min-w-0 flex-col items-start justify-between gap-3 rounded-xl border border-[#dedfd5] bg-[#fffefa] p-4 text-left hover:border-[#3e503c] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#3e503c] disabled:cursor-not-allowed disabled:bg-[#e9eade] disabled:text-[#62685c]">
                    <span className="font-semibold break-words">{product.name}</span>
                    <span className="flex w-full flex-wrap items-center justify-between gap-2"><span className="tabular-nums">{rupiah(product.price)}</span><span className="text-sm font-semibold">{!product.available ? "Habis" : quantity >= 99 ? "Maks. 99" : quantity > 0 ? `${quantity} di keranjang +` : "+ Tambah"}</span></span>
                  </button>;
                })}
              </div>
            </section>
          ))}
        </div>
      </section>
      <aside id="cart" aria-labelledby="cart-heading" className="flex min-h-0 min-w-0 scroll-mt-4 flex-col border-t border-[#dedfd5] bg-[#fffefa] lg:border-t-0 lg:border-l">
        <div className="shrink-0 p-4">
          <h2 id="cart-heading" className="text-xl font-semibold">Keranjang <span className="text-base font-normal">({count} item)</span></h2>
          <fieldset className="mt-4"><legend className="mb-2 text-sm text-[#62685c]">Jenis pesanan</legend><div className="grid grid-cols-2 gap-2">
            {([ ["DINE_IN", "DINE IN"], ["TAKEAWAY", "TAKEAWAY"] ] as const).map(([value, label]) => <button key={value} type="button" aria-pressed={orderType === value} onClick={() => setOrderType(value)} className={`${control} ${orderType === value ? "bg-[#344631] text-white hover:bg-[#293926]" : ""}`}>{label}</button>)}
          </div></fieldset>
        </div>
        <div className="px-4 lg:min-h-0 lg:flex-1 lg:overflow-y-auto">
          {cart.length === 0 ? <p className="py-10 text-center leading-relaxed text-[#62685c]">Keranjang masih kosong.<br />Pilih produk dari menu untuk mulai.</p> : <ul className="divide-y divide-[#dedfd5]">
            {cart.map(({ product, quantity }) => <li key={product.id} className="py-4">
              <div className="flex flex-wrap justify-between gap-2"><h3 className="min-w-0 font-semibold break-words">{product.name}</h3><p className="font-semibold tabular-nums">{rupiah(product.price * quantity)}</p></div>
              <p className="mt-1 text-sm text-[#62685c]">{rupiah(product.price)} / item</p>
              <div className="mt-3 flex flex-wrap items-center justify-between gap-2"><div className="flex items-center gap-2">
                <button type="button" className={control} disabled={quantity === 1} aria-label={`Kurangi ${product.name}`} onClick={() => adjust(product.id, -1)}>−</button>
                <span aria-label={`Jumlah ${product.name}`} className="min-w-8 text-center text-lg tabular-nums">{quantity}</span>
                <button type="button" className={control} disabled={quantity === 99} aria-label={`Tambah jumlah ${product.name}`} onClick={() => adjust(product.id, 1)}>+</button>
              </div><button type="button" className={`${control} text-[#8b3026]`} aria-label={`Hapus ${product.name}`} onClick={() => setCart(current => current.filter(line => line.product.id !== product.id))}>Hapus</button></div>
            </li>)}
          </ul>}
        </div>
        <div className="shrink-0 border-t border-[#dedfd5] p-4">
          <div aria-live="polite" aria-atomic="true" className="flex flex-wrap items-center justify-between gap-2"><span className="font-semibold">Total sementara</span><strong className="text-3xl tabular-nums">{rupiah(total)}</strong></div>
          <p className="mt-3 text-sm leading-relaxed text-[#62685c]">Keranjang belum disimpan. Isi keranjang hilang saat meninggalkan atau memuat ulang halaman.</p>
          <button type="button" disabled aria-describedby="create-order-help" className="mt-4 min-h-14 w-full cursor-not-allowed rounded-lg bg-[#344631] px-5 py-3 text-lg font-semibold text-white opacity-60">Buat Pesanan</button>
          <p id="create-order-help" className="mt-2 text-sm leading-relaxed text-[#62685c]">Penyimpanan pesanan akan diaktifkan pada tahap berikutnya.</p>
        </div>
      </aside>
      <a href="#cart" className="sticky bottom-0 flex min-h-14 items-center justify-between gap-3 bg-[#344631] px-4 py-3 font-semibold text-white focus-visible:outline-2 focus-visible:outline-offset-2 lg:hidden"><span>Lihat keranjang · {count} item</span><span className="tabular-nums">{rupiah(total)}</span></a>
    </div>
  );
}
