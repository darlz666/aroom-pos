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
- Stock Management role (restricted landing only)
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

Milestone 7B explicitly approves only the Stock Management domain/database
foundation described in section 20. Inventory and supplier workflows remain
deferred; the existing role permissions and operational behavior are unchanged.

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
- `/` keeps the register workflow for ADMIN and CASHIER. STOCK_MANAGEMENT and FINANCE see a role-specific “module not available” landing with logout, without shift, POS, orders, receipts, reports, or user-management access. These roles do not introduce inventory or finance features.
- Protect operational pages and server actions independently. Reports and administration remain ADMIN-only. ADMIN navigation links the register, administration, Access Management, and existing daily reports.
- Disable duplicate UI submissions. On an uncertain write or lost connection, reload the user list before allowing another mutation. No user deletion or password reset is included in this scope.

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
| Restricted Role Landing | STOCK_MANAGEMENT and FINANCE module placeholder and logout. |

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
