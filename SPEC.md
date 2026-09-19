# AROOM POS Specification

## 1. Product Goal

Build a simple, reliable, touchscreen-friendly web-based POS system for AROOM Coffee Bar, used primarily as an installable PWA on an Android tablet.

Support the complete cashier workflow: opening a shift, taking orders, receiving payment, printing receipts, and closing and reconciling the shift.

This document is the single source of truth for product behavior and MVP scope.

## 2. Business Assumptions

- One AROOM Coffee Bar outlet.
- One POS register initially.
- Currency is Indonesian Rupiah (IDR); all monetary values are integer rupiah.
- Business reporting timezone is Asia/Jakarta.
- Android tablet is the main cashier device, using an installable PWA.
- Landscape-first touchscreen UI with large touch targets and minimal typing.
- One payment method per order; no split or partial payments.
- An open cashier shift is required before creating transactions.
- Server is authoritative for prices and totals.
- All menu prices are final selling prices.
- Tax = 0.
- Service charge = 0.
- Grand total equals the sum of item totals.
- The system is online-first; offline transactions are not required for MVP.
- A physical BCA EDC terminal is available and manually operated.

## 3. Final MVP Scope

### Authentication

- Login
- Logout
- Admin role
- Cashier role
- Stock Management role (inventory screens; see section 22)
- Finance role (restricted landing only)

### Cashier Shift

- Open shift
- Opening cash balance
- One active shift for the POS register
- Close shift
- Counted cash
- Expected cash
- Cash variance
- Optional discrepancy note, required when closing with a nonzero variance

### Menu

- Product categories
- Products
- Product price
- Product active/inactive state
- Product available/sold-out state

### Cart

- Add product
- Remove product
- Adjust quantity
- Item notes
- Clear cart

### Order

- Dine-in
- Takeaway
- Unique order number
- Order history
- Order detail
- Cancel unpaid order

### Payment

- Cash
- Manual BCA EDC
- Midtrans QRIS

### Receipt

- Display receipt
- Print receipt
- Reprint receipt
- Clearly identify reprinted receipts

### Reporting

- Daily sales total
- Paid order count
- Cash payment total
- BCA EDC payment total
- QRIS payment total
- Shift cash reconciliation

### Administration

- Product management
- Category management
- Basic user management
- Product availability control

## 4. Explicitly Deferred Scope

The following are NOT part of MVP:

- Ingredient inventory
- Purchasing
- Supplier management
- Loyalty
- Delivery integrations
- Multiple outlets
- Multiple registers
- Split payment
- Partial payment
- Complex promotions
- Kitchen display system
- Automatic BCA EDC integration
- Offline transactions
- Complex refunds
- Ingredient deduction
- Purchase orders
- Customer CRM
- Advanced accounting
- Complex product modifiers
- Complex cash-in/cash-out workflows

Do not implement deferred scope unless explicitly approved later.

Milestone 7B approves the Stock Management domain/database foundation in section
20. Milestone 7C additionally approves supplier management and Stock In backend
actions in section 21. Milestone 7D approves the Stock Management UI in section
22. Other inventory workflows remain deferred.

## 5. Roles and Permissions

### Admin

Can:

- Use POS
- Open and close shift
- View all orders
- View reports
- Manage categories
- Manage products
- Change product availability
- Manage users

### Cashier

Can:

- Open their shift
- Use POS
- Create orders
- Process payment
- View order history
- Reprint receipts
- Toggle product availability
- Close their shift

Cashier cannot manage users or perform sensitive administrative configuration. Enforce permissions on the server.

### Access Management

- Only an active ADMIN can access `/admin/users`, list users, create users, change roles, or activate/deactivate accounts.
- Supported roles: ADMIN, CASHIER, STOCK_MANAGEMENT, FINANCE. New accounts are active; login identifiers are trimmed, lowercased, and unique. Passwords use the existing Argon2id hashing and 12–128 character policy.
- List only id, name, login identifier, role, and active status. Never expose password hashes or session data.
- An admin cannot deactivate their own account or change their own role away from ADMIN. At least one active ADMIN must remain; concurrent access changes must preserve these rules.
- Record user creation and actual role/status changes in AuditLog, in the same transaction as the change, without passwords or hashes. Repeating an already-applied role/status change is a no-op.
- Reload the active user and role from the database for every protected request; deactivation and role changes apply to existing sessions on their next request.
- `/` keeps the register workflow for ADMIN and CASHIER. STOCK_MANAGEMENT redirects to `/inventory`; FINANCE sees its “module not available” landing with logout. Neither role has shift, POS, orders, receipts, reports, or user-management access.
- Protect operational pages and server actions independently. Reports and administration remain ADMIN-only. ADMIN navigation links the register, administration, Access Management, and existing daily reports.
- Disable duplicate UI submissions. On an uncertain write or lost connection, reload the user list before allowing another mutation. No user deletion or password reset is included in this scope.

Milestone 7C grants active ADMIN and STOCK_MANAGEMENT users access to the supplier
and Stock In backend actions (section 21). Milestone 7D adds their inventory
screens (section 22). STOCK_MANAGEMENT cannot use POS, shifts, orders, receipts,
reports, or Access Management. CASHIER and FINANCE cannot use inventory actions
or screens.

## 6. Pages / Screens

| Screen | Purpose |
| --- | --- |
| Login | Authenticate an active user in any supported role. |
| Shift Opening | Enter opening cash balance and open the register's shift. |
| POS | Browse products and manage the cart and order type. |
| Payment | Select method and complete cash, manual BCA EDC, or QRIS payment. |
| Receipt / Order Detail | View saved order and payment details; print or reprint receipt. |
| Order History | Find previous orders and open their details. |
| Shift Closing | Count cash, review expected cash and variance, and close shift. |
| Daily Report | View daily sales, payment-method totals, and shift reconciliation. |
| Menu Management | Manage categories, products, prices, and availability. |
| User Management | ADMIN-only Access Management at `/admin/users`: list, create, assign roles, activate/deactivate. |
| Stock Management | ADMIN/STOCK_MANAGEMENT inventory, supplier, receiving, and history screens at `/inventory`. |
| Restricted Role Landing | FINANCE module placeholder and logout. |

Payment and receipt screens may be dialogs or panels within the POS if that improves the cashier workflow.

The POS page should use:

- Category tabs
- Product grid
- Persistent cart
- Large touchscreen buttons
- Clearly visible total
- Minimal typing
- Landscape-first tablet layout

## 7. Main User Flows

### Open Shift

Login → enter opening cash balance → open shift → enter POS.

Only one shift should be active for the register.

### Create Order

Select category → select products → adjust quantities → enter optional notes → choose dine-in or takeaway → checkout.

Before payment, the backend revalidates current product availability and prices. The final order total is calculated by the server. If prices changed, show the updated total for cashier review before payment.

### Cash Payment

Select Cash → enter amount received → calculate change → cashier confirms cash received → payment succeeds → order becomes PAID → receipt shown → attempt printing.

Reject cash received below the order total. Change equals cash received minus order total.

### BCA EDC Payment

Select BCA EDC → POS shows exact amount → cashier enters amount manually into physical BCA EDC → customer completes payment → terminal shows approved → cashier manually confirms approval in POS → optional EDC reference may be entered → payment succeeds → order becomes PAID → receipt shown → attempt printing.

Automatic POS-to-EDC communication is NOT part of MVP. If the terminal result is uncertain, check that result before attempting another payment.

### Midtrans QRIS

Select QRIS → backend creates Midtrans payment → POS displays QR → customer scans and pays → backend receives and verifies Midtrans notification → payment becomes SUCCEEDED → order becomes PAID → receipt shown → attempt printing.

Important rules:

- Never mark QRIS as paid from frontend callback alone.
- Never allow cashier to manually mark QRIS payment as successful.
- Payment success must be verified server-side.
- Webhook processing must be idempotent.
- Delayed notifications must be recoverable using server-side payment status checks.
- Expired QRIS attempts should not make the order disappear.
- Retrying payment must not create duplicate successful charges.
- Resolve an existing pending or uncertain attempt before retrying or switching payment methods. A request timeout alone does not establish failure.

### Printer Failure

Payment succeeds → printing is attempted → printer fails → order remains PAID → show print error → allow retry → allow later reprint from order history.

Printing failure must NEVER reverse payment or change order/payment status.

### Close Shift

Resolve pending or uncertain payments before closing. Show:

- Opening cash
- Cash sales
- Expected cash
- Counted cash

Calculate:

Expected cash = opening cash + successful cash sales

Variance = counted cash - expected cash

Cash sales use paid order amounts, not cash tendered before returning change. QRIS and BCA EDC totals do not affect physical drawer cash.

Require a discrepancy note when variance is nonzero; otherwise the note is optional. Then close shift and preserve its closing values.

## 8. Order Statuses

Use only these MVP order statuses:

| Status | Meaning |
| --- | --- |
| UNPAID | Order has been saved but does not yet have a successful payment. |
| PAID | Successful payment has been recorded. |
| CANCELLED | An unpaid order has been cancelled after confirming there is no successful payment and no unresolved active payment attempt. |

Allowed normal transitions:

- UNPAID → PAID
- UNPAID → CANCELLED

Paid orders:

- Cannot be edited
- Cannot be deleted
- Cannot be cancelled through normal cashier actions

A failed or expired payment attempt leaves the order UNPAID. Unexpected verified payment evidence must not be discarded; flag it for admin reconciliation.

## 9. Payment Statuses

| Status | Meaning |
| --- | --- |
| PENDING | Waiting for payment confirmation, including an unresolved or uncertain result. |
| SUCCEEDED | Payment was successfully completed. |
| FAILED | Payment definitively failed. |
| EXPIRED | QRIS payment attempt was confirmed expired. |
| CANCELLED | Payment attempt was safely cancelled before payment. |

Payment status must remain separate from order status. A single order may have multiple unsuccessful payment attempts before one succeeds. Cash may be recorded directly as SUCCEEDED when the cashier confirms receipt.

## 10. Simplified Database Entities

### User

- id
- name
- login identifier
- password hash
- role
- active status
- createdAt
- updatedAt

### Category

- id
- name
- display order
- active status

### Product

- id
- categoryId
- name
- price
- available
- active
- createdAt
- updatedAt

Price must be stored as integer rupiah.

### Shift

- id
- cashierId
- openedAt
- closedAt
- openingCash
- expectedCash
- countedCash
- variance
- closingNote
- status

Shift status is OPEN or CLOSED. Closing fields remain unset until closing; expected cash can be calculated for display while the shift is open and saved at close.

### Order

- id
- orderNumber
- shiftId
- cashierId
- orderType
- status
- total
- createdAt
- paidAt
- cancelledAt

Order type is DINE_IN or TAKEAWAY.

### OrderItem

- id
- orderId
- productId
- productNameSnapshot
- unitPriceSnapshot
- quantity
- notes
- lineTotal

Historical name and price snapshots must remain unchanged when the product menu changes later. Quantity is a positive integer. Line total equals unit price snapshot multiplied by quantity; notes do not change the price.

### Payment

- id
- orderId
- method
- status
- amount
- attemptIdentifier
- cashReceived
- changeAmount
- edcReference
- midtransReference
- createdAt
- updatedAt
- succeededAt

Methods are CASH, BCA_EDC, and MIDTRANS_QRIS. Method-specific fields are only populated when applicable. Payment amount equals the full order total.

### PaymentNotification

- id
- paymentId
- provider
- notificationIdentifier or fingerprint
- processing result
- receivedAt
- processedAt

Used mainly for safe Midtrans webhook processing. Deduplicate repeated notifications while allowing distinct status events for the same payment.

### AuditLog

Keep this minimal. Record only important sensitive actions such as:

- Product price change
- User management
- Shift closing
- Sensitive admin changes

Fields:

- id
- actorId
- action
- entityType
- entityId
- details
- createdAt

## 11. Relationships

- Category has many Products.
- Shift has many Orders.
- User can own many Shifts.
- User can create many Orders.
- Order has many OrderItems.
- Order has many Payment attempts.
- Payment can have many PaymentNotifications.

No Outlet or Register tables are required in MVP. AROOM business identity, receipt settings, and timezone can be stored in application configuration.

## 12. Payment Rules

- Server calculates all totals.
- Frontend totals are display-only.
- One successful payment per order.
- Prevent duplicate submissions.
- Payment finalization must use database transactions to record payment success and the PAID order together.
- Successful payment cannot be overwritten by stale failed notifications.
- Never expose payment credentials to the frontend.
- QRIS success is determined server-side.
- Cash is confirmed by cashier.
- BCA EDC is manually confirmed by cashier after physical terminal approval.
- Printing is completely independent from payment success.
- Reuse or reconcile an existing attempt after an interrupted request rather than blindly creating another charge.

## 13. BCA EDC Manual Workflow

The physical BCA EDC terminal is not directly integrated into the POS in MVP.

Cashier:

1. Selects BCA EDC.
2. Reads the exact amount from the POS.
3. Processes that amount on the physical EDC.
4. Waits for APPROVED result.
5. Confirms approval in the POS.
6. May optionally enter EDC reference.
7. POS records payment as successful.

Automatic EDC integration is future scope.

## 14. Midtrans QRIS Rules

- Midtrans Server Key must exist only on the server.
- Backend creates Midtrans transaction/payment.
- Frontend receives only safe transaction information required to display payment.
- Payment notifications/webhooks are verified server-side, including matching the transaction and amount to the saved payment attempt.
- Process duplicate webhook events safely.
- Never trust frontend payment completion callback as final proof.
- Query Midtrans server-side if payment state needs reconciliation.
- Handle pending, success, failed, and expired provider states through the payment statuses defined above.
- Prevent duplicate successful payments.
- A delayed or repeated notification must not downgrade a successful payment or finalize the order twice.

## 15. Receipt Requirements

Receipt paper: 58 mm thermal paper.

Confirmed printer: EPPOS EP58M / RPP02N Bluetooth thermal printer.

Receipt should contain:

- AROOM Coffee Bar
- Order number
- Date
- Time
- Cashier name
- Dine-in or Takeaway
- Item name
- Quantity
- Unit price
- Line total
- Grand total
- Payment method

For Cash:

- Cash received
- Change

For BCA EDC:

- Payment method
- Optional reference

For QRIS:

- Payment method

Reprinted receipt should clearly say COPY or REPRINT. Display dates and times in Asia/Jakarta and format amounts as rupiah. Fit receipt content to 58 mm paper.

Do not show tax or service charge lines because AROOM has no additional tax/service charge.

## 16. Printer Architecture

Do not couple POS business logic directly to EPPOS RPP02N. Use a PrinterAdapter abstraction.

Conceptually:

Receipt Service → PrinterAdapter → Android Print Bridge → Bluetooth → EPPOS EP58M / RPP02N

The Android print bridge implementation will be selected and tested separately on the actual tablet and printer. Confirming the printer model does not by itself verify PWA-to-printer compatibility.

The business flow should only request `printReceipt(order)` and should not depend directly on a specific Bluetooth protocol or printer model.

Printer errors must:

- Be visible to the cashier
- Support retry
- Support reprint
- Never invalidate payment

## 17. Online-First Connectivity Rule

MVP requires server connectivity for checkout.

If connectivity is unavailable:

- Show clear offline state.
- Do not silently queue payments.
- Do not attempt Midtrans QRIS.
- Do not create duplicate transactions.

Offline checkout is deferred. After an interrupted request, recover the saved order/payment status from the server before retrying; connectivity loss does not prove a payment failed.

## 18. Reporting

Daily reports should derive from orders, payments, and shifts, using Asia/Jakarta business dates. Daily paid sales and payment-method totals use the successful payment time (`paidAt` / `succeededAt`), not unpaid order creation time.

Show:

- Total paid sales
- Paid order count
- Cash total
- BCA EDC total
- Midtrans QRIS total
- Opening cash
- Expected closing cash
- Counted cash
- Cash variance

Exclude unpaid and cancelled orders from paid sales. Count each successful payment once. Show cash reconciliation per shift, including when a shift spans midnight; a shift's reconciliation covers all its cash sales rather than only one calendar day's sales.

Do not create a separate report table unless later required.

## 19. Development Milestones

### Milestone 1 — Documentation and specification

- Establish SPEC.md and AGENTS.md.

### Milestone 2 — Project foundation

- Next.js
- TypeScript
- Database (PostgreSQL)
- Authentication
- Roles
- PWA foundation

### Milestone 3 — Menu and user administration

### Milestone 4 — Shift opening

### Milestone 5 — POS catalog and cart

### Milestone 6 — Order creation

### Milestone 7 — Cash payment

### Milestone 7B — Stock Management Foundation

- Ingredient, supplier, product recipe relations, units, and immutable movement schema.
- Domain validation and optional ingredient unit cost only; see section 20.

### Milestone 7C — Stock In + Supplier Management

- Supplier metadata services and atomic inventory receiving; see section 21.

### Milestone 7D — Stock Management UI

- Protected inventory screens using existing models and receiving actions; see section 22.

### Milestone 8 — Manual BCA EDC payment

### Milestone 9 — Midtrans QRIS sandbox

### Milestone 10 — Receipt generation and Android printer integration

### Milestone 11 — Order history and reprint

### Milestone 12 — Shift closing and reporting

### Milestone 13 — Production readiness and supervised pilot

Each milestone should be completed and tested before expanding scope. Production readiness includes financial retry/recovery checks, permission enforcement, backup restoration, actual Android/printer validation, and a supervised trading shift with reconciled totals.

## 20. Stock Management Foundation (Milestone 7B)

- One Ingredient represents one shared physical inventory item. Its currentStock
  is the sole inventory balance; recipes and products never own allocated stock.
- Ingredient stores name, canonical baseUnit, currentStock, minimumStock, active,
  timestamps, and an optional nonnegative integer-rupiah unitCost per one base
  unit. Null cost means unknown. No cost calculations are included.
- Accept g, kg, ml, L, and pcs. Canonical stored units are g, ml, and pcs; convert
  1 kg to 1000 g and 1 L to 1000 ml. Units cannot change after ingredient creation.
  Quantities use exact decimals with up to three decimal places and fifteen
  integer digits. Reject invalid precision, overflow, negatives, and incompatible
  units rather than rounding or clamping. No packaging or density conversions.
- Ingredient names are required, trimmed, and unique ignoring case and surrounding
  spaces, including inactive ingredients. Metadata input cannot set currentStock;
  new balances default to zero. Future stock services must calculate changes on
  the server.
- Supplier stores required name, optional contact/phone/address, active, and
  timestamps. No purchasing workflow or supplier-to-ingredient allocation exists.
- The existing Product has at most one Recipe. RecipeItem references Recipe and
  Ingredient, has positive quantity in the ingredient's canonical unit, and is
  unique per recipe/ingredient pair. Validate references against database rows.
  Many recipes may use the same ingredient. Recipes never affect selling prices,
  POS availability, order snapshots, or balances in this milestone.
- StockMovement supports PURCHASE, SALE_CONSUMPTION, ADJUSTMENT_IN, and
  ADJUSTMENT_OUT, with positive quantity, canonical unit, nonnegative stockAfter,
  optional source type/id pair, optional User actor, and creation timestamp.
  Movement records cannot be updated or deleted. No movement-writing workflow
  exists yet; future services must atomically record movements and balances.
- No inventory pages, actions, permission grants, Stock In, Recipe UI, HPP,
  weighted-average/FIFO/LIFO costing, POS stock consumption, or Finance changes.
  STOCK_MANAGEMENT and FINANCE retain their restricted landing and logout.

## 21. Stock In + Supplier Management (Milestone 7C)

- Backend only. Active ADMIN and STOCK_MANAGEMENT may list, create, edit, and
  activate/deactivate suppliers, create Stock In, and read a saved Stock In.
  Every action uses the existing session authorization; services recheck the
  database role and active status. No inventory pages or other role grants.
- Reuse Supplier metadata validation and active flag. No hard-delete action.
  Supplier creation and actual metadata changes use the existing transactional
  AuditLog. Supplier names remain nonunique display names as in 7B.
- StockIn stores a unique ID, server-generated unique reference number, supplier
  and supplier-name snapshot, explicit receivedAt instant, authenticated actor,
  optional notes, creation timestamp, and immutable StockInItem records.
- Each item references the shared Ingredient, snapshots its name, and stores
  positive input quantity/unit, normalized base quantity/unit, integer-rupiah
  unitCost per ONE canonical base unit, and server-calculated lineTotal.
  Costs must be nonnegative; fractional-rupiah totals and 32-bit integer overflow
  are rejected without rounding. Ingredient.unitCost is not changed; weighted
  average costing, HPP, and valuation remain deferred.
- Accept 1–100 distinct ingredients per receipt. Reuse exact 7B conversions,
  precision and quantity limits. No product-specific stock, packaging conversion,
  purchase orders, stock consumption, or automatic product availability changes.
- Validate supplier/ingredients as active, normalize all items, create the receipt
  and items, insert one PURCHASE movement per ingredient, and update shared
  Ingredient.currentStock in ONE database transaction. Lock ingredients in ID
  order; overflow or any write failure rolls back the entire receipt.
- Movement sourceType is StockIn and sourceId is the receipt ID. Record canonical
  quantity, resulting balance and actor. Stock In headers/items and movements
  cannot be updated or deleted. Supplier/ingredient edits never rewrite history.
- A required UUID idempotency key identifies each submission. Concurrent or later
  identical retries by the same actor return the committed receipt without adding
  stock. Reusing the key for different content/actor is rejected. After lost
  connectivity or an uncertain response, retry the same payload with the SAME
  key; never generate a new key for that delivery. No offline queue.
- receivedAt requires ISO date/time with explicit UTC offset; store an instant
  and use Asia/Jakarta for future display/reporting. createdAt is server time.

## 22. Stock Management UI (Milestone 7D)

- `/inventory` is server-guarded with the existing inventory authorization for
  active ADMIN and STOCK_MANAGEMENT only. Every read/write action independently
  authenticates and rechecks database access. CASHIER, FINANCE, and anonymous
  users are rejected. ADMIN navigation links inventory; STOCK_MANAGEMENT lands
  there from `/`. Logout remains available without a cashier shift.
- Touch-friendly, landscape-first tabs: Stok bahan, Supplier, Stock In, and
  Riwayat Stock In. Preserve the form while switching tabs. No new models.
- Show Ingredient name, exact currentStock, base unit, minimumStock and active
  state. Calculate stock status on the server: zero = Habis, positive stock at
  or below minimum = Stok rendah, above minimum = Tersedia. Inactive is a separate
  label. Search names and filter status; failed reads never masquerade as zero.
- Suppliers use existing create/update/list actions, including contact, phone,
  address and active state. No deletion. Prevent duplicate submissions and require
  authoritative list reload after an uncertain write before allowing another.
- Stock In selects active suppliers and ingredients, accepts input quantities,
  compatible units, integer-rupiah cost per canonical unit, optional notes and
  received date/time explicitly in WIB. Support multiple distinct ingredients.
  The 7C backend owns conversion, validation, costs, movements and balances.
- Block duplicate clicks and offline submissions. Retain an unresolved request's
  exact payload and idempotency key in sessionStorage scoped to actor and browser
  tab BEFORE sending; fail before sending if recovery storage is unavailable.
  Recovery after reload is explicit with the same payload/key, never automatic
  or an offline transaction queue. Lock edits while unresolved, including after
  later errors. Clear recovery only on success or a definite first-attempt
  rejection. Confirm success from the server before enabling a new receipt.
- After receiving, reload stock and history. History uses bounded 25-record
  pages ordered by creation time/ID, with supplier snapshots, reference, received
  time, actor, item count and server total. Details show saved names, quantities,
  units, costs, notes and timestamps in Asia/Jakarta, without edit/delete controls.
  Superseded reads cannot replace newer results; failures offer explicit retry.
- Ingredient creation/editing, recipe editing, POS stock consumption, HPP,
  stock adjustment/opname, Finance workflows and expanded role permissions remain
  outside this milestone.
