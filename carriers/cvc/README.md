# CVC

Tracks parcels and pallets carried by CVC in Bulgaria.

## Retrieval

The public e-CVC tracking page takes a waybill in `wb` and the form's
`checkit` button value. The result must name the same waybill. The explicit
`Пратката не е открита!` form message means that CVC could not find it.

The adapter reads the dated Bulgarian scan text and keeps the local clocks
as shown. The tracker does not supply offsets or a separate scan location.

## Numbers

Select CVC explicitly or open an e-CVC tracking link that contains the waybill.

## Testing

`CVC_TRACKING_NUMBER=… npm run test:carriers:live -- carriers/cvc`
