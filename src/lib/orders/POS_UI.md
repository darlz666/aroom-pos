# POS UI — Milestones 3F1 / 3F2 / 3F3 / 3F4

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
  payment navigation, or payment processing.


## 3F3 — Edit/cancel existing UNPAID orders

- The active UNPAID list loads on entry, explicit list refresh, and once after a
  confirmed create, edit, or cancel success. There is no polling or WebSocket.
- Both read actions authenticate a fresh server actor. Services derive the current
  OPEN shift; CASHIER may operate only their own shift and ADMIN retains existing
  ADMIN_VIEW semantics. No client-provided shiftId. Lists are newest first.
- Selection performs an authoritative detail read. Cross-shift, PAID, CANCELLED,
  and missing orders all return ORDER_NOT_FOUND without exposing their existence.
  Reads return explicit safe DTOs without payment or internal request metadata.
- **Pesanan Baru** is the local draft. **Edit AR-xxxxxx** displays only the selected
  server order's number, status, type, total, items, snapshot prices and revision.
  The local cart and type controls are hidden while editing. Returning to the new
  order reveals the unchanged draft. Product taps in edit mode add to the saved
  order and never alter the local draft.
- Edit payloads contain orderId, expectedRevision and one ADD_ITEM, SET_QUANTITY,
  or REMOVE_ITEM operation. No price/name/total/shift/cashier authority fields.
  Success replaces the complete authoritative detail including the returned
  revision; the next mutation uses that revision.
- One persisted read/mutation runs at a time, guarded synchronously before render.
  Pending mutations visibly disable product additions and saved-order controls.
  Undefined guard results never imply success or remove selection.
- REVISION_CONFLICT freezes all persisted edits and cancellation. Only explicit
  **Muat Ulang Pesanan** can recover the session with an authoritative detail and
  revision. No automatic retries, revision adoption, or recovery via list refresh.
  Transport uncertainty also requires explicit detail reload before more edits.
- PAYMENT_BLOCKED preserves the authoritative detail. ORDER_NOT_EDITABLE and
  ORDER_NOT_FOUND mutation failures exit stale editing and refresh the list.
- Cancellation requires confirmation. The optional reason is limited to 500
  characters, trimmed and forwarded as cancellationReason. Confirmed success
  exits edit mode and refreshes the active list; no optimistic removal.
- This milestone adds no payment UI or payment operation, PAID-order editing,
  browser persistence, offline synchronization, or printer coupling.

## 3F4 — Final POS polish and acceptance

- 3F1 provides the local cart; 3F2 creates orders; 3F3 edits/cancels existing
  UNPAID orders. 3F4 polishes these flows without changing business behavior.
- Empty local carts instruct the cashier to select a menu product. Active orders
  show loading before the first read and show **Belum ada pesanan aktif** only
  after a successful empty read. Failed reads show an actionable error instead
  of a misleading empty state; list refresh remains explicit.
- Detail reads and mutations show separate progress messages. Saved-order mode
  explains that totals come from the server and each edit saves immediately.
  Local draft guidance and **Total sementara** remain separate.
- Selected active orders expose their pressed state. Saved-item controls have
  product-specific accessible labels. Cancellation names the selected order,
  labels the optional reason, and retains readable confirmation hover contrast.
  Existing synchronous mutation guards and 48px touch targets are retained.
- Acceptance tests exercise create → active selection → edit → dismiss cancel
  confirmation → cancel → create another order, plus empty/loading/error states,
  disabled controls, exact-request retries and revision-conflict recovery.
  Login/open-shift navigation was reviewed; existing shift/POS gate tests cover
  authenticated access and shift entry. This is component/boundary coverage,
  not a live browser journey.
- The accepted responsive classes are unchanged: below 1024px the menu/cart
  stack with a sticky summary; at 1024px and above they sit side-by-side.
  Class regression checks pass. Visual acceptance at 1440×900, 1280×800,
  1024×768 and 768×1024 still requires browser verification; no browser tooling
  was available in this session.
- Verification: 28 UI tests and 66 order checks pass; lint, typecheck, production
  build, Prisma validation and migration status pass. The create and edit/cancel
  PostgreSQL integration suites stop at their idle-register prerequisites because
  the local database has an open shift. That shift was left intact. Full live
  journey and database integration acceptance remain outstanding.
