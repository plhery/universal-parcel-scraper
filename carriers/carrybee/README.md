# CarryBee

CarryBee Express Ltd is a courier in Dhaka, Bangladesh. It delivers the parcels of online and
social-media sellers to homes in every district of Bangladesh, with apps for merchants and
agents. Its site is carrybee.com.

## Retrieval

The tracking page is a Next.js app that reads `consignmentId` from the address and asks the
merchant API for that consignment. `direct` asks it the same way,
`GET https://api-merchant.carrybee.com/api/v2/track-order?consignment_id=<number>`, with no session,
account or verification. `retry` repeats only a network failure within the lookup budget.

The reply must name the requested number as its `consignment_id`. It holds two lists:

- `logs`, the history, each title with an offset clock (`+06:00`) and the status id it moved the
  order to. Its wordings match Pathao's history.
- `states`, the page's journey rail: every step, those reached (`status: 1`) with an epoch clock.
  A step at the same second as a history row repeats it in a shorter label and is dropped; the
  others (picked, in transit, received at the last-mile hub) fill gaps the history leaves. Epoch
  clocks are shown in Dhaka's time, the one offset Bangladesh keeps all year.

The current stage comes from the order's `current_status`, else the newest scan. The rider's name
and phone number after "Your parcel is out for delivery by" are taken out of the wording. The
recipient, merchant, rider, contents, weight and amounts in the same reply are never read.

HTTP 404 with `rpc error: code = NotFound desc = record not found` is not-found. Any other 404 or
`error: true` reply is inconclusive.

## Numbers

The only public example is eleven letters and digits starting with a letter, from an
aggregator. That layout fits many carriers, so there is no rule and CarryBee is tracked when chosen.

## Links

`carrybee.com/track?consignmentId=<number>` opens one parcel. The merchant site's older
`tracking` page answers 404.

## Limitations

The history names no place. The estimate is a window of days, dropped once it is past or the
parcel is delivered, returned or stopped.

## Testing

`CARRYBEE_TRACKING_NUMBER=<number> CARRYBEE_UNKNOWN_NUMBER=<number> npm run test:carriers:live -- carriers/carrybee`
