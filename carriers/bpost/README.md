# bpost

Tracks parcel barcodes through the anonymous batch service used by bpost's
official frontend.

## How it works

One POST requests one barcode and returns minimized history
without a postcode. The single-item GET requires a postcode and can return a
missing-item error for a parcel the batch service knows.

## Notes

The returned item and search barcode must both match. Order references and
ambiguous results need an exact parcel barcode. Status comes from the newest
scan's English wording; pickup availability remains distinct from delivery.
Delivery to the sender is a return milestone; an ambiguous return delivery is
inconclusive. The same cheap lookup lets carrier recognition resolve ambiguous
numeric barcodes; only the batch service's explicit absence reply is negative.
The [documented parcel prefixes](https://www.bpost.be/en/faq/what-does-barcode-look-and-where-can-i-find-it)
prioritize recognition while retaining numeric ambiguity.

The receiver's country code becomes `destination_country`. While the parcel
waits at a pickup point, `pickup_point` is that point's name. The sender's
barcode becomes `international_tracking_number` only when it is a valid S10
number other than the one searched, as on a parcel posted abroad.

## Limitations

Scan clocks have no offsets. The adapter preserves their local digits and the
provider's order; see [ROUTING.md](https://github.com/plhery/delivery-tracker/blob/main/docs/ROUTING.md) for unresolved
history handling. Weight and dimensions have explicit units. Addresses (pickup
points' included), other recipient data, delivery instructions and proof assets
are excluded. The delivery time bpost lists for a delivered parcel has no offset
either, so `delivered_at` stays empty.

## Testing

Run `npm run test:carriers:live -- carriers/bpost`.
Set `BPOST_TRACKING_NUMBER` outside the repository to check a real parcel.
