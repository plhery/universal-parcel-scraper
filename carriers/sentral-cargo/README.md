# Sentral Cargo

The adapter tracks Sentral Cargo's Indonesian freight receipts when Sentral Cargo is selected.

## Retrieval

The public `/cekresi` page renders the shipment when given one `resi` value. The adapter checks
the whole receipt in the result heading. The page's missing notice must also name the requested
receipt.

Scan timestamps keep the offset in the page's `datetime` values. The adapter separates depot
movement, delivery rounds and partial deliveries despite their shared “On Process” label. It keeps
a depot location only when the scan names an office. Proof-of-delivery images are left out.

## Testing

`SENTRAL_CARGO_TRACKING_NUMBER=… SENTRAL_CARGO_UNKNOWN_NUMBER=… npm run test:carriers:live -- carriers/sentral-cargo`
