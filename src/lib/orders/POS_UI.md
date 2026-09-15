# POS UI — Milestone 3F1

- Route: `/pos`, reached from **Buka POS** on the shift dashboard.
- The server page authenticates the user, gates access with the existing shift
  helper, then reads Category/Product data. CASHIER needs their own OPEN shift;
  ADMIN follows the existing OWNED/ADMIN_VIEW semantics. Blocked or unavailable
  shift state never renders an operational cart or queries the menu.
- Prisma selects only the menu DTO fields: category `id`, `name`, `products`;
  product `id`, `name`, `price`, `available`. Only active categories and products
  load. Sold-out products remain visible but disabled.
- Client `PosMenu` owns only the selected category, local cart, and order type
  (DINE IN/TAKEAWAY). Quantities range from 1–99; items can be removed.
- Local cart, prices, and totals are untrusted display state. The server remains
  authoritative for product name, price, availability, and order total.
- Leaving/reloading clears the cart. 3F1 has no order persistence, browser
  storage, API requests, or order action calls. **Buat Pesanan** is a disabled,
  non-submitting placeholder. 3F2 will connect `createOrderAction`.
- At widths of 1024px and above, the layout uses a side-by-side
  menu/cart with independently scrolling content and a visible cart footer.
  Below 1024px, screens stack the sections and show a sticky cart
  summary link. Category navigation scrolls horizontally; controls are at least
  48px tall. Physical tablet/browser visual verification remains outstanding.
