# Paack

Last-mile carrier for online retailers in Spain, Portugal, France and the UK. Tracked through
the public recipient page, which needs the order number or label barcode and the delivery
postcode.

## How it works

1. `direct`: one bounded `GET https://mydeliveries.paack.app/tracking/order?tracking_number=…&postal_code=…`
   with `redirect: 'manual'`. The page is a Remix app, so the `routes/tracking.order` loader
   response is already embedded in `window.__remixContext`; reading it avoids a second
   undocumented API call and gives exactly what the page renders.
   - Paack checks the number and postcode as a pair. A wrong pair is redirected back to the
     form with `err=true`; that redirect or an HTTP 404 is not-found.
   - The page is moving to `paack.co/shipments`, and the old host forwards some lookups there
     before checking the postcode. A redirect to the same lookup on a Paack host is followed
     once; any other redirect is `IndeterminateError`, never not-found.
   - "Order not found" / "Incorrect order number or postal code" (and French and Spanish
     variants) in the HTML or loader payload is also not-found.
   - A tracking page is the order for the pair. It does not echo a label barcode:
     `external_id` is then the retailer's own reference, so it is not compared. It does echo
     `delivery_address.post_code`; one that differs from the requested postcode in its letters
     and digits is a `SchemaError`.
   - An empty HTTP 200 is `IndeterminateError`.
   - No postcode on the parcel raises `InputRequiredError`.

## Notes

- Numbers are retailer order numbers or label barcodes with no stable shape, so there is no
  detection rule: a rule would cost precision for every other carrier. Paack is picked
  manually or through a `mydeliveries.paack.app` link.
- The postcode is half of the lookup key, so it is a credential: never log it, commit it or
  put it in an issue.
- Stages come from each entry's stable `id` and `label` (a translation key), never from the
  localized text. Both are reduced to letters and digits and matched by substring, so
  suffixed variants (`scannedAtOriginHeader`) land on the same stage.
- Failure rules run before delivery rules: `notDelivered` contains `delivered`.
- Scheduled returns (`returnToSenderScheduled`, `returnAbsent`, `returnOther`) are
  `failed_attempt`, not `returned`, so a parcel that can still be delivered stays active.
- PaackGo Point (pickup point) steps come from the tracking page's own labels and are matched
  before the generic words they contain. `droppedInPudo` is `ready_for_pickup` and
  `collectedByCustomer` is delivered, not a transit `collected`. A point that is closed, full
  or refuses the parcel (`rejectedByPudo`) is a `failed_attempt` Paack retries. A parcel that
  expires, is refused or goes unpaid at the point (`inPudoToReturn…`) is `returned`.
- While the parcel waits at a PaackGo Point, `pickup_point` is `pudo_name`, then
  `pudo_address` on the following lines, or the name alone. The address is one string Paack
  formats itself; like the page, it is kept as it comes and only broken where it holds a line
  break.
- `activeEvent` decides the overall status when it maps: the banner can be ahead of the
  timeline. The timeline keeps its own per-event stages.
- The timeline also lists the steps still to come, without a timestamp. Those and entries
  flagged `timeline: false` are skipped; the rest are sorted newest first and capped at 100.
- Event descriptions are our own English wording. Unknown identifiers read "Shipment update".
- Aggregators relay the page's English labels instead of identifiers. `paackScan` maps those
  exact labels for them and stores the same wording as the direct lookup.
- Event times are parsed locally, not with `core/time`: the loader mixes epoch seconds,
  epoch milliseconds and ISO strings with offsets in one field, and the result keeps
  millisecond precision.
- `expected_delivery` is the delivery window, `expected_delivery_ts`, as
  `YYYY-MM-DD HH:MM–HH:MM`. Its ends are instants, and the page shows them on the delivery
  country's clock (the Canary Islands' for Spanish postcodes 35 and 38), so the result does
  too and takes that clock as its `timezone`. A window across midnight, or without an
  offset, keeps only its last day. It is dropped once delivered or in exception, and when it
  ended before the newest scan.
- Retailer, recipient name, e-mail, phone, address and per-event `variables` (which
  interpolate them) are never read; a test asserts it. The PaackGo Point's pickup code
  (`pudo_passcode`), QR link and collection deadline are not read either. The delivery
  postcode is only compared with the requested one. The delivery country, and in Spain the
  postcode's province, only pick the clock.

## Limitations

- No event locations: events carry only the order's country, not where the scan happened.
- No live PaackGo Point reply has been seen; the pickup-point labels and fields come from the
  tracking page's code and translations.

## Testing

`npm run test:carriers:live -- carriers/paack` checks that Paack's own retired API examples
return not-found. Set `PAACK_TRACKING_NUMBER` and `PAACK_POSTCODE` to also track a private
parcel with every step mapped and check that another postcode is not-found.
