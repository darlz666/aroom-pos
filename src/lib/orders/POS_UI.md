# POS UI — Milestones 3F1 / 3F2

- Route: `/pos`, reached from **Buka POS** on the shift dashboard.
- The server page authenticates the user, gates access with the existing shift
  helper, then reads Category/Product data. CASHIER needs their own OPEN shift;
  ADMIN follows existing OWNED/ADMIN_VIEW semantics. Blocked or unavailable
  shift state never renders an operational cart or queries the menu.
- Prisma selects only category `id`, `name`, `products` and product `id`, `name`,
  `price`, `available`. Only active categories/products load; sold-out products
  remain visible but disabled.
- Client PosMenu owns category selection, local cart, DINE_IN/TAKEAWAY, and
  creation state. Quantities range from 1–99; local items can be removed.
- At widths of 1024px and above, the layout uses a side-by-side menu/cart with
  independently scrolling content and a visible cart footer. Below 1024px,
  sections stack with a sticky cart summary link. Category navigation scrolls
  horizontally; controls are at least 48px tall. The accepted 3F1 layout is retained.

## 3F2 — Create order

- **Buat Pesanan** calls only `createOrderAction()`. The exact payload is
  `{ createIdempotencyKey, orderType, items: [{ productId, quantity }] }`.
  No names, prices, totals, shift/actor fields, status, revision, or fingerprint
  are submitted. Local cart prices/totals remain untrusted display previews.
- First submission generates one browser `crypto.randomUUID()` and captures
  the request with lowercase product IDs sorted by ID. The snapshot is held in
  React memory. Unchanged retries reuse its key, type, and quantities verbatim.
- A synchronous guard prevents double submission before rerender. Pending,
  uncertain, conflict, and success acknowledgement states disable cart mutation.
- `CREATE_FAILED` and thrown transport errors may follow a committed creation.
  Preserve the cart and exact snapshot, freeze edits, warn against leaving or
  reloading, and offer **Coba Lagi**. No automatic retries or replacement keys.
  A later error after uncertainty remains frozen (authorization failure cannot
  prove the earlier attempt did not commit); only success recovers the result.
- `IDEMPOTENCY_CONFLICT` blocks further creation and asks the operator to
  reload/review status. It never generates a replacement key or auto-submits.
- Definite validation errors display the action's Indonesian message and leave
  the cart editable. Unchanged retries retain the key; cart/type edits clear
  the error and snapshot, so the next submission receives a fresh UUID.
- Success displays authoritative `order.orderNumber`, `order.total`, and
  `order.status`. A different server total is displayed without resubmission.
  `replayed: true` adds a recovered-request note without another create call.
  Success clears the cart, resets DINE_IN, and consumes the snapshot/key.
  The confirmation remains until **Pesanan Baru**; the next draft uses a new key.
- No browser storage, offline queue, or recovery across page reloads. No payment,
  payment navigation, or edit/cancel existing orders UI yet.
