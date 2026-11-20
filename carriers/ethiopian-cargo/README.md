# Ethiopian Cargo

Select Ethiopian Cargo explicitly and enter the master air waybill with its 071 prefix. The [guest tracking form](https://cargo.ethiopianairlines.com/my-cargo/track-your-shipment) accepts the airway bill as printed, including the hyphen.

## Retrieval

The adapter submits the guest form and checks the eight-digit serial on the result. It reads the dated shipment history, using the piece count on a movement to distinguish parts of a consignment that move at the same time. Times remain as printed. A shipment history entry can confirm delivery. The schedules in their separate panel describe flights and are excluded from the parcel history.

## Testing

`ETHIOPIAN_CARGO_TRACKING_NUMBER=… ETHIOPIAN_CARGO_UNKNOWN_NUMBER=… npm run test:carriers:live -- carriers/ethiopian-cargo`
