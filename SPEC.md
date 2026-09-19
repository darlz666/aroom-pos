# AROOM POS Specification

## 1. Product Goal

Build a simple, reliable, touchscreen-friendly web-based POS system for AROOM Coffee Bar, used primarily as an installable PWA on an Android tablet.

Support the complete cashier workflow: opening a shift, taking orders, receiving payment, printing receipts, and closing and reconciling the shift.

This document is the single source of truth for product behavior and MVP scope.

## 2. Business Assumptions

- One AROOM Coffee Bar outlet.
- One POS register initially.
- Currency is Indonesian Rupiah (IDR); transaction amounts are integer rupiah.
  Milestone 7E internal ingredient costs use scaled integers as defined in section
  23; monetary calculations must never use floating-point arithmetic.
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
22. Milestone 7E's required costing design is defined in section 23. Other
inventory workflows remain deferred except POS sale consumption explicitly
approved by Milestone 7G in section 24.

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

### Milestone 7E - Ingredient WAC and current recipe HPP

- Weighted Average Cost is the required ingredient costing method, never latest
  purchase price. Precision, receiving safety, history, and acceptance criteria
  are defined in section 23. This design does not mark implementation complete.

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

## 23. Ingredient Costing Decision (Milestone 7E)

This section defines the required 7E design and supersedes the costing deferrals
and integer-only ingredient unit-cost design in sections 20-22 for 7E. Existing
7B-7D implementation remains unchanged until 7E is implemented and verified.

### Ownership and scope

- Each Ingredient has one immutable canonical inventory unit (g, ml, or pcs),
  one currentStock balance, and one current weighted-average unit cost (WAC).
- WAC belongs to inventory costing. Products/recipes reference the same shared
  Ingredient; a recipe neither owns nor allocates stock and has no balance.
- Recipe HPP reads current ingredient WAC on the server. Latest purchase price
  must never substitute for WAC. Recipe edits and HPP reads do not change stock,
  selling prices, POS availability, orders, payments, or printing.
- No automatic POS stock deduction, historical HPP snapshots, stock adjustment,
  purchase orders, Finance workflows, or new role permissions are introduced.
  Existing ADMIN/STOCK_MANAGEMENT inventory authorization remains mandatory.

### Integer precision and rounding policy

- Store the one authoritative WAC as nullable PostgreSQL BIGINT / Prisma BigInt,
  named weightedAverageUnitCostMicros: integer millionths of one rupiah per ONE
  canonical unit. Rp1 = 1000000 micro-rupiah. Null means unknown; zero means a
  known zero cost. Do not keep Ingredient.unitCost as a second writable costing
  authority after migration.
- Whole-rupiah WAC per ml/g would discard meaningful purchase precision. Six
  decimal places preserve fractional costs while keeping storage integer-based.
  This is a bounded fixed-point approximation, not an exact recurring fraction;
  each receipt rounds WAC once and subsequent receipts use that saved WAC.
- Parse decimal quantity strings into integer thousandths of the canonical unit
  (Q); keep the existing Decimal(18,3) quantity limits. Use TypeScript BigInt for
  all cost products, sums, division, and rounding. Do not convert intermediate
  values to Number or depend on a Decimal library's default precision.
- For nonnegative numerator N and positive denominator D, round-half-up means
  floor(N / D) + (2 * (N mod D) >= D ? 1 : 0). Apply it only at the explicit
  boundaries below. Reject negative values, invalid units/precision, and overflow
  rather than clamping. Serialize scaled costs as decimal integer strings.
- Retain the current maximum canonical unit cost of Rp2147483647, represented as
  2147483647000000 micro-rupiah. Validate this bound before storage. BigInt
  intermediates must handle products larger than PostgreSQL BIGINT without loss.
  Transaction totals and final HPP amounts remain whole rupiah; preserve existing
  32-bit transaction amount limits and reject HPP totals exceeding that limit.

### Receiving and original purchase evidence

- Accept original purchase quantity, supported purchase unit, and integer-rupiah
  price per purchase unit. Normalize quantity and cost to the canonical unit on
  the server: kg -> g and L -> ml use a factor of 1000, otherwise factor 1.
  receivedCostMicros = purchaseUnitCostRupiah * 1000000 / factor. With these
  allowed factors, this conversion is exact; no rounding is needed.
- Preserve the original purchase quantity/unit, price and its unit basis, saved
  normalized quantity/cost, and saved integer-rupiah line total in immutable
  StockInItem records. Calculate purchase totals from the original purchase
  terms, never WAC. Preserve 7C's rejection of fractional-rupiah purchase totals
  and transaction overflow; WAC rounding does not change invoice amounts.
- Existing 7C/7D requests and receipts use unitCost per canonical unit, independent
  of inputUnit. Never reinterpret that value as a price per L/kg. Version the new
  purchase-unit input contract and retain legacy retries/fingerprints and history
  semantics, including unresolved sessionStorage requests across deployment.
  Historical records cannot gain an invented original supplier price.
- For existing quantity Qold, saved WAC Cold, received quantity Qin, and normalized
  received cost Cin (both costs in micro-rupiah):

  Cnew = roundHalfUp((Qold * Cold + Qin * Cin) / (Qold + Qin)).

  Quantities in this formula use the same integer-thousandths scale, which cancels.
  When Qold = 0, Cnew = Cin, including when the previous cost was null. For positive
  stock with unknown WAC, reject receiving with a clear costing error until that
  opening cost is resolved; never treat unknown stock as free or use latest price.
- For each successful receipt, update Ingredient.currentStock and its WAC in the
  SAME transaction as the immutable receipt, items, and PURCHASE movements.
  Reuse the per-idempotency-key lock and check for replay before costing. An
  identical retry returns the saved receipt without applying stock or WAC again;
  different content/actor with the same key remains a conflict.
- Acquire Ingredient FOR UPDATE locks in ingredient ID order. Read quantity and
  WAC after acquiring each lock and hold all locks through commit. Distinct
  concurrent receipts must each use the preceding committed balance and WAC.
  A failure on any line or later write rolls back all quantities, costs, history,
  and movements. Each ingredient in a receipt calculates WAC independently.
- Keep the existing 1-100 distinct ingredients per receipt rule. Receiving the
  same ingredient on successive receipts updates its same balance and WAC.
  Costing follows serialized posting order, not a backdated receivedAt value;
  backdating must not recalculate previously posted receipts.
- Example: 5000 ml at Rp30/ml plus 12 L at Rp35000/L means Qin = 12000 ml,
  Cin = Rp35/ml, original purchase total = Rp420000, stockAfter = 17000 ml,
  and WAC = Rp33.529412/ml (stored integer 33529412).

### Current recipe HPP

- For each recipe ingredient, multiply its exact canonical quantity in
  thousandths by the current WAC in micro-rupiah. The product is an exact integer
  numerator with denominator 1000000000 for a rupiah amount.
- Round each ingredient HPP contribution half-up to whole rupiah, then sum those
  integer contributions to obtain recipe HPP. This deliberately makes the total
  equal the sum of the displayed contributions; do not instead round only the
  unrounded recipe sum. Read all ingredients from one consistent database
  snapshot so a concurrent receipt cannot produce a mixture of old/new costs.
- Example: 100 ml * Rp33.529412/ml = Rp3352.9412 -> Rp3353. Two contributions
  of Rp0.50 each round to Rp1 each and produce Rp2 total under this policy.
- If any referenced ingredient has unknown WAC, return HPP as unavailable and
  identify the missing cost. Never silently substitute zero or latest purchase
  price. Zero stock with known WAC can still provide an estimated current HPP.
- Future WAC changes affect only current estimates. Existing Stock In records,
  order/receipt data, and any historical HPP snapshots introduced later must
  never be rewritten from current WAC.

### Migration requirements

- Existing Ingredient.unitCost is optional metadata and Stock In never maintained
  it. Do not assume it is a valid WAC or blindly copy it as an opening valuation.
- Reconstruct current WAC only where immutable receiving history proves a complete
  balance from zero: verify quantities, units, PURCHASE movements, stockAfter
  sequence, and final currentStock; replay the same rounding policy in that proven
  posting sequence. Do not assume createdAt/receivedAt sorts concurrent receipts
  into their actual posting order. Update only current ingredient costing state.
- Positive balances with incomplete or inconsistent provenance require explicit
  resolution before enabling WAC receiving; never invent an opening cost. Empty
  ingredients may start with unknown WAC and acquire it on their first receipt.
- Preserve old history rows and their cost basis, immutability protections, and
  idempotency behavior. Add schema constraints for the new representation and
  reconcile the legacy Ingredient.unitCost field without two cost authorities.

### Required verification before 7E completion

- Exact integer tests: first receipt, zero-cost receipt, additional receipts,
  the 5000/12000 ml example, fractional canonical costs (Rp33333/L -> Rp33.333/ml),
  fractional quantities, half-micro WAC ties, below/at/above Rp0.50 HPP ties,
  per-contribution HPP rounding, repeated receipt rounding, and maximum-value
  intermediate arithmetic beyond Number.MAX_SAFE_INTEGER and BIGINT products.
- Validate incompatible units, excess quantity precision, negative costs,
  fractional purchase totals, overflow, and positive-stock/unknown-WAC errors.
- PostgreSQL tests: independent WAC for multiple ingredients, multiple recipes
  sharing one ingredient, sequential receipts, concurrent distinct receipts on
  overlapping ingredients in opposite input order, and concurrent identical
  retries. Assert final stock AND WAC plus receipt/movement counts.
- Inject failures after writes to prove rollback of stock AND WAC for every line.
  Simulate lost responses and retry the exact key/payload; verify conflict handling
  and legacy replay compatibility after migration.
- Change WAC again and confirm saved purchase quantities, units, costs, amounts,
  and unrelated historical POS data are unchanged. Verify HPP reads/recipe edits
  never allocate or deduct stock, and retain all existing permission boundaries.
- Test migration against complete, missing, and inconsistent legacy histories,
  including concurrent posting order. Run relevant lint, TypeScript typecheck,
  domain tests, and database integration tests before declaring implementation done.

## 24. POS Stock Deduction (Milestone 7G)

- Successful POS payment finalization records payment success, the PAID order,
  ingredient deductions, immutable SALE_CONSUMPTION movements and payment audit
  in one database transaction. No stock is consumed by recipe edits, unpaid or
  cancelled orders, or failed/pending/expired payment attempts. Any deduction
  failure rolls back the entire local payment/order transaction.
- Resolve saved OrderItem.productId through the existing Product -> Recipe ->
  RecipeItem -> Ingredient relations. Use current server-side recipes at
  finalization, protected by Product locks shared with 7F recipe saves through
  commit. The existing recipe model has no activation flag; a missing or empty
  recipe is not configured. Referencing any inactive ingredient rejects the sale.
- Aggregate every order line and product's consumption against each shared
  Ingredient balance. Reuse canonical g/ml/pcs units and kg/L conversions, with
  exact integer-thousandths arithmetic. Never use client recipe data, round
  stock quantities, silently skip invalid ingredients, or allow negative stock.
- Lock ingredients in ID order, as receiving does, and read balances after
  acquiring locks. Concurrent sales/receipts use the preceding committed balance.
  Insufficient stock and invalid inventory state produce controlled business
  errors. WAC is independent of selling prices and is not changed by consumption;
  unknown WAC does not prevent a quantity-based sale. COGS/Finance reporting,
  reservations, stock adjustment UI and automatic availability changes are deferred.
- Reuse payment attempt idempotency. A committed retry returns the saved payment
  before reading current recipes or consuming stock, including after shift close
  or later recipe changes. Do not retroactively consume pre-7G paid orders.
- Reuse StockMovement with a positive consumption magnitude, canonical unit,
  stockAfter, server timestamp, actor where applicable, and Payment source ID.
  Its paymentId foreign key preserves the payment and linked immutable order
  identity; a unique payment/ingredient pair prevents duplicate movements.
  Existing movement history is not rewritten.
- Current integration covers cash and manual BCA EDC finalization. QRIS remains
  unavailable until its existing deferred provider workflow is implemented; that
  workflow must use the same atomic consumption boundary on verified success.
  Local rollback cannot reverse an already approved physical EDC charge. Keep
  the existing instruction to check recording and never charge again on error.
- Preserve existing POS architecture, authorization, order/receipt snapshots,
  printer isolation and 7F permissions (including Finance recipe reads). Add only
  payment error messages for missing recipes, inactive ingredients, insufficient
  stock, inventory conflicts and invalid inventory state. No stock-deduction
  action is exposed to clients.
