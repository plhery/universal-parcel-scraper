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

The receiver's country code becomes `destination_country`. The sender's
barcode becomes `international_tracking_number` only when it is a valid S10
number other than the one searched, as on a parcel posted abroad.

The reply's `deliveryPoint` is the pickup point or locker itself, apart from
the receiver: bpost's tracker shows it with opening hours and directions from
its own coordinates. While the parcel waits there, and once it is delivered
with bpost's active step saying it was picked up there (`PICKED_UP_IN_…`, which
the tracker shows as "Collected"), `pickup_point` is the point's name, then its
street and number, then postcode and town, in one language. It is the name
alone when the street or town is missing. A parcel delivered to the door has
none.

## Limitations

Scan clocks have no offsets. The adapter preserves their local digits and the
provider's order; see [ROUTING.md](https://github.com/plhery/delivery-tracker/blob/main/docs/ROUTING.md) for unresolved
history handling. Weight and dimensions have explicit units. Recipient and
sender names and addresses, the point's code, delivery instructions and proof
assets are excluded. The delivery time bpost lists for a delivered parcel has no
offset either, so `delivered_at` stays empty.

## Testing

Run `npm run test:carriers:live -- carriers/bpost`.
Set `BPOST_TRACKING_NUMBER` outside the repository to check a real parcel.
