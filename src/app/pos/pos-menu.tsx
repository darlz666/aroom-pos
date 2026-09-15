"use client";

import { useEffect, useRef, useState } from "react";
import { cancelOrderAction, createOrderAction, editOrderAction, getActiveUnpaidOrderAction, listActiveUnpaidOrdersAction } from "@/lib/orders/actions";
import type { CreateOrderInput } from "@/lib/orders/domain";
import type { EditOperation } from "@/lib/orders/domain";
import type { SafeOrder } from "@/lib/orders/actions";

type Creation =
  | { state: "idle" | "submitting" }
  | { state: "uncertain" | "validation-error" | "conflict"; error: string }
  | { state: "success"; order: Extract<Awaited<ReturnType<typeof createOrderAction>>, { success: true }>["order"] };
const uncertainMessage = "Status pesanan belum dapat dipastikan. Coba kirim ulang pesanan yang sama untuk memeriksa hasilnya. Jangan meninggalkan atau memuat ulang halaman ini.";

type MenuProduct = { id: string; name: string; price: number; available: boolean };
export type MenuCategory = { id: string; name: string; products: MenuProduct[] };
type CartLine = { product: MenuProduct; quantity: number };
const rupiah = (value: number) => `Rp${new Intl.NumberFormat("id-ID").format(value)}`;
const control = "min-h-12 min-w-12 rounded-lg border border-[#a8aea0] px-3 font-semibold hover:bg-[#e9eade] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#3e503c] disabled:cursor-not-allowed disabled:opacity-40";

export function PosMenu({ categories }: { categories: MenuCategory[] }) {
  const [categoryId, setCategoryId] = useState<string | null>(null);
  const [cart, setCart] = useState<CartLine[]>([]);
  const [orderType, setOrderType] = useState<"DINE_IN" | "TAKEAWAY">("DINE_IN");
  const [creation, setCreation] = useState<Creation>({ state: "idle" });
  const [selectedOrder, setSelectedOrder] = useState<SafeOrder | null>(null);
  const [orderRefresh, setOrderRefresh] = useState(0);
  // Synchronous guards also protect handlers invoked before React rerenders.
  const locked = useRef(false);
  const pending = useRef(false);
  const snapshot = useRef<CreateOrderInput | null>(null);
  const wasUncertain = useRef(false);
  const orderMutationPending = useRef(false);
  const conflictLock = useRef(false);
  const [persistedPending, setPersistedPending] = useState(false);
  const [conflicted, setConflicted] = useState(false);
  const [persistedError, setPersistedError] = useState<string | null>(null);
  const frozen = !["idle", "validation-error"].includes(creation.state);
  function editDraft() {
    if (locked.current) return false;
    snapshot.current = null;
    setCreation({ state: "idle" });
    return true;
  }
  async function submit() {
    if (pending.current || (locked.current && !wasUncertain.current) || !cart.length) return;
    if (!snapshot.current) {
      snapshot.current = {
        createIdempotencyKey: crypto.randomUUID(), orderType,
        items: cart.map(({ product, quantity }) => ({ productId: product.id.toLowerCase(), quantity }))
          .sort((a, b) => a.productId < b.productId ? -1 : a.productId > b.productId ? 1 : 0),
      };
    }
    pending.current = true;
    locked.current = true;
    setCreation({ state: "submitting" });
    try {
      const result = await createOrderAction(snapshot.current);
      if (result.success) {
        setCart([]);
        setOrderType("DINE_IN");
        snapshot.current = null;
        wasUncertain.current = false;
        setCreation({ state: "success", order: result.order });
        setOrderRefresh(value => value + 1);
      } else if (result.code === "IDEMPOTENCY_CONFLICT") {
        wasUncertain.current = false;
        setCreation({ state: "conflict", error: result.error });
      } else if (result.code === "CREATE_FAILED" || wasUncertain.current) {
        wasUncertain.current = true;
        setCreation({ state: "uncertain", error: result.code === "CREATE_FAILED" ? uncertainMessage : `${result.error} ${uncertainMessage}` });
      } else {
        locked.current = false;
        setCreation({ state: "validation-error", error: result.error });
      }
    } catch {
      wasUncertain.current = true;
      setCreation({ state: "uncertain", error: uncertainMessage });
    } finally {
      pending.current = false;
    }
  }
  const visibleCategories = categories.filter(category => categoryId === null || category.id === categoryId);
  const count = cart.reduce((sum, line) => sum + line.quantity, 0);
  // Display-only preview; the action result owns the saved total.
  const total = cart.reduce((sum, line) => sum + line.product.price * line.quantity, 0);

  function add(product: MenuProduct) {
    if (!product.available) return;
    if (selectedOrder) {
      void mutatePersisted({ type: "ADD_ITEM", productId: product.id, quantity: 1 });
      return;
    }
    if (!editDraft()) return;
    setCart(current => {
      const existing = current.find(line => line.product.id === product.id);
      if (existing) return current.map(line => line.product.id === product.id ? { ...line, quantity: Math.min(99, line.quantity + 1) } : line);
      return [...current, { product, quantity: 1 }];
    });
  }

  async function runMutation(operation?: EditOperation, reason?: string) {
    if (!selectedOrder || orderMutationPending.current || conflictLock.current) return;
    orderMutationPending.current = true;
    setPersistedPending(true);
    setPersistedError(null);
    try {
      const input = { orderId: selectedOrder.id, expectedRevision: selectedOrder.revision };
      const result = operation ? await editOrderAction({ ...input, operation })
        : await cancelOrderAction({ ...input, ...(reason ? { cancellationReason: reason } : {}) });
      if (!result) return;
      if (result.success) {
        setSelectedOrder(operation ? result.order : null);
        setOrderRefresh(value => value + 1);
      } else {
        setPersistedError(result.error);
        if (result.code === "REVISION_CONFLICT" || result.code === "UPDATE_FAILED" || result.code === "CANCEL_FAILED") {
          conflictLock.current = true;
          setConflicted(true);
        }
        if (result.code === "ORDER_NOT_EDITABLE" || result.code === "ORDER_NOT_FOUND") {
          setSelectedOrder(null);
          setOrderRefresh(value => value + 1);
        }
      }
      return result;
    } catch {
      setPersistedError("Status perubahan belum dapat dipastikan. Muat ulang pesanan sebelum melanjutkan.");
      conflictLock.current = true;
      setConflicted(true);
    } finally { orderMutationPending.current = false; setPersistedPending(false); }
  }
  const mutatePersisted = (operation: EditOperation) => runMutation(operation);
  const cancelPersisted = (reason?: string) => runMutation(undefined, reason);

  async function reloadPersisted(orderId: string, explicit = false) {
    if (orderMutationPending.current || (conflictLock.current && !explicit)) return;
    orderMutationPending.current = true;
    setPersistedPending(true);
    try {
      const result = await getActiveUnpaidOrderAction(orderId);
      if (result.success) {
        setSelectedOrder(result.order);
        conflictLock.current = false;
        setConflicted(false);
        setPersistedError(null);
      } else {
        setPersistedError(result.error);
        if (result.code === "ORDER_NOT_FOUND" || result.code === "ORDER_NOT_EDITABLE") {
          setSelectedOrder(null);
          conflictLock.current = false;
          setConflicted(false);
          setOrderRefresh(value => value + 1);
        }
      }
      return result;
    } catch {
      setPersistedError("Pesanan belum dapat dimuat. Periksa koneksi dan coba lagi.");
    } finally { orderMutationPending.current = false; setPersistedPending(false); }
  }

  function adjust(id: string, delta: number) {
    if (!editDraft()) return;
    setCart(current => current.map(line => line.product.id === id ? { ...line, quantity: Math.max(1, Math.min(99, line.quantity + delta)) } : line));
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col lg:grid lg:grid-cols-[minmax(0,1fr)_minmax(20rem,0.65fr)]">
      <ActiveOrders refreshToken={orderRefresh} selectedOrder={selectedOrder} pending={persistedPending} conflicted={conflicted} mutationError={persistedError} onSelect={order => { if (!orderMutationPending.current && !conflictLock.current) setSelectedOrder(order); }} onMutate={mutatePersisted} onCancel={cancelPersisted} onReload={reloadPersisted} />
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
                  const quantity = selectedOrder ? 0 : cart.find(line => line.product.id === product.id)?.quantity ?? 0;
                  return <button key={product.id} type="button" disabled={(selectedOrder ? persistedPending || conflicted : frozen) || !product.available || quantity >= 99} onClick={() => add(product)} aria-label={`Tambah ${product.name}`} className="flex min-h-36 min-w-0 flex-col items-start justify-between gap-3 rounded-xl border border-[#dedfd5] bg-[#fffefa] p-4 text-left hover:border-[#3e503c] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#3e503c] disabled:cursor-not-allowed disabled:bg-[#e9eade] disabled:text-[#62685c]">
                    <span className="font-semibold break-words">{product.name}</span>
                    <span className="flex w-full flex-wrap items-center justify-between gap-2"><span className="tabular-nums">{rupiah(product.price)}</span><span className="text-sm font-semibold">{!product.available ? "Habis" : quantity >= 99 ? "Maks. 99" : quantity > 0 ? `${quantity} di keranjang +` : "+ Tambah"}</span></span>
                  </button>;
                })}
              </div>
            </section>
          ))}
        </div>
      </section>
      {!selectedOrder && <aside id="cart" aria-labelledby="cart-heading" className="flex min-h-0 min-w-0 scroll-mt-4 flex-col border-t border-[#dedfd5] bg-[#fffefa] lg:border-t-0 lg:border-l">
        <div className="shrink-0 p-4">
          <h2 id="cart-heading" className="text-xl font-semibold">Pesanan Baru <span className="text-base font-normal">({count} item)</span></h2>
          <fieldset className="mt-4"><legend className="mb-2 text-sm text-[#62685c]">Jenis pesanan</legend><div className="grid grid-cols-2 gap-2">
            {([ ["DINE_IN", "DINE IN"], ["TAKEAWAY", "TAKEAWAY"] ] as const).map(([value, label]) => <button key={value} type="button" aria-pressed={orderType === value} disabled={frozen} onClick={() => { if (editDraft()) setOrderType(value); }} className={`${control} ${orderType === value ? "bg-[#344631] text-white hover:bg-[#293926]" : ""}`}>{label}</button>)}
          </div></fieldset>
        </div>
        <div className="px-4 lg:min-h-0 lg:flex-1 lg:overflow-y-auto">
          {cart.length === 0 ? <p className="py-10 text-center leading-relaxed text-[#62685c]">Keranjang masih kosong.<br />Pilih produk dari menu untuk mulai.</p> : <ul className="divide-y divide-[#dedfd5]">
            {cart.map(({ product, quantity }) => <li key={product.id} className="py-4">
              <div className="flex flex-wrap justify-between gap-2"><h3 className="min-w-0 font-semibold break-words">{product.name}</h3><p className="font-semibold tabular-nums">{rupiah(product.price * quantity)}</p></div>
              <p className="mt-1 text-sm text-[#62685c]">{rupiah(product.price)} / item</p>
              <div className="mt-3 flex flex-wrap items-center justify-between gap-2"><div className="flex items-center gap-2">
                <button type="button" className={control} disabled={frozen || quantity === 1} aria-label={`Kurangi ${product.name}`} onClick={() => adjust(product.id, -1)}>−</button>
                <span aria-label={`Jumlah ${product.name}`} className="min-w-8 text-center text-lg tabular-nums">{quantity}</span>
                <button type="button" className={control} disabled={frozen || quantity === 99} aria-label={`Tambah jumlah ${product.name}`} onClick={() => adjust(product.id, 1)}>+</button>
              </div><button type="button" className={`${control} text-[#8b3026]`} aria-label={`Hapus ${product.name}`} disabled={frozen} onClick={() => { if (editDraft()) setCart(current => current.filter(line => line.product.id !== product.id)); }}>Hapus</button></div>
            </li>)}
          </ul>}
        </div>
        <div className="shrink-0 border-t border-[#dedfd5] p-4">
          <div aria-live="polite" aria-atomic="true" className="flex flex-wrap items-center justify-between gap-2"><span className="font-semibold">Total sementara</span><strong className="text-3xl tabular-nums">{rupiah(total)}</strong></div>
          {creation.state === "success" ? <div role="status" className="mt-4 rounded-lg border border-[#344631] bg-[#e9eade] p-4">
            <h3 className="text-lg font-semibold">Pesanan berhasil dibuat</h3>
            <p>Nomor pesanan: <strong>{creation.order.orderNumber}</strong></p>
            <p>Total: <strong>{rupiah(creation.order.total)}</strong></p>
            <p>Status: <strong>{creation.order.status}</strong></p>
            {creation.order.replayed && <p className="mt-2 text-sm">Pesanan ditemukan kembali dari permintaan sebelumnya.</p>}
            <button type="button" className={control + " mt-3 w-full"} onClick={() => { locked.current = false; setCreation({ state: "idle" }); }}>Pesanan Baru</button>
          </div> : <>
            {"error" in creation && <p role="alert" className="mt-3 rounded-lg border border-[#8b3026] p-3 text-[#8b3026]">{creation.error}{creation.state === "conflict" && " Tinjau pesanan dan muat ulang status sebelum melanjutkan. Jangan membuat permintaan pengganti."}</p>}
            {creation.state === "submitting" && <p role="status" className="mt-3">Menyimpan pesanan. Keranjang dikunci sementara.</p>}
            {(creation.state === "idle" || creation.state === "validation-error") && <p className="mt-3 text-sm leading-relaxed text-[#62685c]">Keranjang belum disimpan. Isi keranjang hilang saat meninggalkan atau memuat ulang halaman.</p>}
            <button type="button" disabled={cart.length === 0 || creation.state === "submitting" || creation.state === "conflict"} onClick={submit} className="mt-4 min-h-14 w-full rounded-lg bg-[#344631] px-5 py-3 text-lg font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60">{creation.state === "submitting" ? "Menyimpan..." : creation.state === "uncertain" ? "Coba Lagi" : "Buat Pesanan"}</button>
          </>}
        </div>
      </aside>}
      {!selectedOrder && <a href="#cart" className="sticky bottom-0 flex min-h-14 items-center justify-between gap-3 bg-[#344631] px-4 py-3 font-semibold text-white focus-visible:outline-2 focus-visible:outline-offset-2 lg:hidden"><span>Lihat keranjang · {count} item</span><span className="tabular-nums">{rupiah(total)}</span></a>}
    </div>
  );
}

type MutationResponse = Awaited<ReturnType<typeof editOrderAction>> | Awaited<ReturnType<typeof cancelOrderAction>>;

function ActiveOrders({
  refreshToken,
  selectedOrder,
  onSelect,
  onMutate,
  onCancel,
  onReload, pending, conflicted, mutationError,
}: {
  pending: boolean;
  conflicted: boolean;
  mutationError: string | null;
  refreshToken: number;
  selectedOrder: SafeOrder | null;
  onSelect: (order: SafeOrder | null) => void;
  onMutate: (operation: EditOperation) => Promise<MutationResponse | undefined>;
  onCancel: (reason?: string) => Promise<MutationResponse | undefined>;
  onReload: (orderId: string, explicit?: boolean) => Promise<Awaited<ReturnType<typeof getActiveUnpaidOrderAction>> | undefined>;
}) {
  const [orders, setOrders] = useState<SafeOrder[]>([]);
  const [error, setError] = useState<string | null>(null);

  const [confirmCancel, setConfirmCancel] = useState(false);
  const [reason, setReason] = useState("");
  const listRequest = useRef(0);

  async function load() {
    const request = ++listRequest.current;
    try {
      const result = await listActiveUnpaidOrdersAction();
      if (request !== listRequest.current) return;
      if (result.success) { setOrders(result.orders); setError(null); }
      else setError(result.error);
    } catch {
      if (request === listRequest.current) setError("Daftar pesanan belum dapat dimuat. Periksa koneksi dan coba lagi.");
    }
  }
  useEffect(() => {
    const timer = window.setTimeout(() => { void load(); }, 0);
    return () => window.clearTimeout(timer);
  }, [refreshToken]);

  async function select(order: SafeOrder, explicit = false) {
    const result = await onReload(order.id, explicit);
    if (result?.success) { setConfirmCancel(false); setReason(""); }
  }

  async function cancel() {
    if (!confirmCancel || reason.length > 500) return;
    const result = await onCancel(reason.trim() || undefined);
    if (result?.success) { setConfirmCancel(false); setReason(""); }
  }

  return <section aria-labelledby="active-orders-heading" className="col-span-full border-b border-[#dedfd5] bg-[#fffefa] p-4 sm:p-6">
    <div className="flex flex-wrap items-baseline justify-between gap-2">
      <h2 id="active-orders-heading" className="text-xl font-semibold">Pesanan Aktif</h2>
      <button type="button" className={control} onClick={() => void load()} disabled={pending}>Muat ulang daftar</button>
    </div>
    {(mutationError || error) && <p role="alert" className="mt-3 rounded-lg border border-[#8b3026] p-3 text-[#8b3026]">{mutationError || error}</p>}
    {orders.length === 0 ? <p className="mt-3 text-[#62685c]">Belum ada pesanan aktif.</p> : <div className="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
      {orders.map(order => <button key={order.id} type="button" disabled={pending || conflicted} onClick={() => { if (!pending && !conflicted) void select(order); }} className={`${control} flex h-auto min-h-20 flex-col items-start gap-1 text-left ${selectedOrder?.id === order.id ? "border-[#344631] bg-[#e9eade]" : "bg-[#fffefa]"}`}>
        <strong>{order.orderNumber}</strong><span>{rupiah(order.total)} · {order.items.reduce((sum, item) => sum + item.quantity, 0)} item</span><span className="text-sm text-[#62685c]">{order.orderType === "DINE_IN" ? "DINE IN" : "TAKEAWAY"} · {new Intl.DateTimeFormat("id-ID", { timeZone: "Asia/Jakarta", dateStyle: "short", timeStyle: "short" }).format(new Date(order.createdAt))}</span>
      </button>)}
    </div>}
    {selectedOrder && <div className="mt-5 rounded-xl border border-[#a8aea0] p-4" aria-label={`Detail ${selectedOrder.orderNumber}`}>
      <div className="flex flex-wrap items-center justify-between gap-2"><div><h3 className="text-lg font-semibold">Edit {selectedOrder.orderNumber}</h3><p className="text-sm text-[#62685c]">{selectedOrder.status} · {selectedOrder.orderType} · Revisi {selectedOrder.revision} · Total {rupiah(selectedOrder.total)}</p></div><button type="button" className={control} disabled={pending} onClick={() => void select(selectedOrder, true)}>Muat Ulang Pesanan</button></div>
      <ul className="mt-3 divide-y divide-[#dedfd5]">{selectedOrder.items.map(item => <li key={item.id} className="flex flex-wrap items-center justify-between gap-2 py-3"><span className="min-w-0"><strong>{item.productName}</strong><span className="ml-2 text-sm text-[#62685c]">{rupiah(item.unitPrice)} / item</span></span><span className="flex items-center gap-2"><button type="button" className={control} disabled={pending || conflicted || item.quantity <= 1} onClick={() => void onMutate({ type: "SET_QUANTITY", orderItemId: item.id, quantity: item.quantity - 1 })}>−</button><span className="min-w-6 text-center">{item.quantity}</span><button type="button" className={control} disabled={pending || conflicted || item.quantity >= 99} onClick={() => void onMutate({ type: "SET_QUANTITY", orderItemId: item.id, quantity: item.quantity + 1 })}>+</button><button type="button" className={`${control} text-[#8b3026]`} disabled={pending || conflicted} onClick={() => void onMutate({ type: "REMOVE_ITEM", orderItemId: item.id })}>Hapus</button></span></li>)}</ul>
      {confirmCancel ? <div className="mt-3 rounded-lg border border-[#8b3026] p-3"><p className="font-semibold">Batalkan pesanan ini?</p><input disabled={pending || conflicted} value={reason} onChange={event => setReason(event.target.value)} maxLength={500} placeholder="Alasan (opsional)" className="mt-2 min-h-12 w-full rounded-lg border border-[#a8aea0] px-3" /><div className="mt-2 flex flex-wrap gap-2"><button type="button" className={`${control} bg-[#8b3026] text-white`} disabled={pending || conflicted || reason.length > 500} onClick={() => void cancel()}>Ya, batalkan</button><button type="button" className={control} disabled={pending} onClick={() => setConfirmCancel(false)}>Kembali</button></div></div> : <button type="button" className={`${control} mt-3 text-[#8b3026]`} disabled={pending || conflicted} onClick={() => setConfirmCancel(true)}>Batalkan pesanan</button>}
      <button type="button" className={control + " mt-3"} disabled={pending || conflicted} onClick={() => onSelect(null)}>Kembali ke Pesanan Baru</button>
    </div>}
  </section>;
}
