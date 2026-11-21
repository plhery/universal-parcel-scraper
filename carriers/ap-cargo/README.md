# AP Cargo

AP Cargo carries cargo between its branches across the Philippines. Tracked through the lookup
its tracking page on `apcargo.com.ph/track/` makes, with the delivery its older tracker records.

## How it works

1. `direct`: `GET https://ojt8n5mafh.execute-api.ap-southeast-1.amazonaws.com/Prod/waybill-tracking?waybillNumber={number}`,
   the request the tracking page makes with the number its form reads, and at the same time
   `GET https://api.apcargo.com.ph/api/DeliveryStatus/external?airwaybill={number}`, AP Cargo's
   older tracker. Neither needs a cookie, token, key or browser.
2. `retry`: the same reads once more when AP Cargo cannot be reached.

- The tracker answers with HTTP 200. A found waybill comes as its record: sender, consignee, an
  internal waybill code and `Items`, one per day, each with `DeliveryStatus` rows of status,
  location and clock, newest first.
- For a number it does not hold, the tracker wraps an empty record in
  `{"success":false,"statusCode":404,…}` and the page shows "Record not found.": that is not
  found. Another wrapped status is a failure of its kind, 429 a rate limit, and any other reply a
  changed one.
- API Gateway's 403 `Missing Authentication Token`, a redirect, or an HTTP 404 or 410 is a moved
  route. Any other 403, or a block page, is a block.
- The record never repeats the number; it names the shipment by an internal code. The lookup
  matches whole numbers only: a digit more or fewer, or a leading zero, is not found. The adapter
  sends whole eight-digit numbers only, so the request ties the reply to the number.

## Notes

- The tracker can stop at `Out for Delivery` while the older tracker records the delivery. When
  the tracker's history holds no delivery, the older tracker's is added if its reply names the
  number and the delivery falls on or after the day of the tracker's newest row. The older
  tracker decides nothing else, and a failed read of it is ignored.
- Clocks are branch wall clocks without a zone, kept as `local_time`. A row at midnight is a
  row without a time of day, kept as its date and listed above the scans of that day; the older
  tracker dates its deliveries this way. A clock that does not parse stays as text.
- `Received` after the arrival at the destination branch is the consignee taking the cargo: the
  older tracker reports the same waybill delivered that day.
- Sender and consignee names are kept as the tracker writes them, surname and given names in
  either order around a comma. The internal waybill code is dropped.

## Limitations

- No estimate, weight, service, proof of delivery or delivery time as an instant.
- A waybill that only the older tracker holds is not found.

## Numbers

AP Cargo waybill numbers have eight digits. Eight digits are shared by several carriers and
nothing in the number points to AP Cargo, so no rule claims them; AP Cargo is tracked when it is
chosen. The samples and their sources are in [`numbers.json`](numbers.json).

## Links

AP Cargo's tracking page reads the waybill number from a form and asks a separate API for the
result, so no address opens one parcel.

## Testing

`AP_CARGO_TRACKING_NUMBER=… npm run test:carriers:live -- carriers/ap-cargo`, with the number set
outside the repository. `AP_CARGO_UNKNOWN_NUMBER` adds a check of a made-up number.
