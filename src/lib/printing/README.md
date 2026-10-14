# Receipt and cup-label printing

Only use the freshly authorized, paid-only receipt projection for printing. The
receipt renderer formats stored quantities, prices, totals and payment details;
it never recalculates financial values. The 58 mm receipt has a logical 32-column
layout, Jakarta timestamps, customer name and a `COPY` mark for historical reprints.

Cup labels are a separate output. `formatCupLabels()` renders exactly one label
per saved beverage cup, with deterministic cup numbering across the order. Food
and historical items without saved cups generate no guessed labels. Each label
preserves its individual sugar, ice, cup size and notes. Layout is logical text;
sticker dimensions are intentionally unspecified until a printer is selected.

`PrinterAdapter` and `LabelPrinterAdapter` separate content from transport and
reserve independent `receipt` and `labels` destinations. The unconfigured defaults
fail visibly. `createSimulatedReceiptAdapter()` and
`createSimulatedLabelAdapter()` contact no hardware; completion returns
`status: "simulated"`, never `"succeeded"`. Controlled steps can throw or wait to
exercise errors and retries without Bluetooth. Successful physical adapters must
only resolve after their supported completion criteria are satisfied. The fake
physical adapter is confined to tests.

Receipt and label jobs have separate busy guards in this application instance.
Duplicate calls or overlapping jobs for the same destination return `busy` without
being queued. Each cup has its own job, so retrying a failed cup does not repeat
completed cups. Jobs capture immutable content once; retries use that snapshot.
Completed jobs are terminal. A deliberate later copy requires a new job generated
from the authorized stored projection with `copy: true`.

Printing is read-only and has no database or payment dependency. Error results
never settle payments, reverse settlement, consume inventory, or change orders.
The receipt panel provides a separate text preview and simulation button for the
receipt and each cup. Simulated results explicitly say that nothing was printed
physically. Physical attempts retain their own errors and retry controls.

Android must eventually target two independently selected Bluetooth printers.
No Web Bluetooth connection, ESC/POS sequence, vendor sticker command or native
bridge is implemented here. Select the sticker model/dimensions and supported
Android bridge separately. On the real tablet and both devices, verify permissions,
pairing, destination selection, Unicode/fonts, receipt fit, label fit, disconnects,
paper errors and whether transport acknowledgment establishes physical completion.
The busy guards are per app instance, not a cross-device hardware lock.
