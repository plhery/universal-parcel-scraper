# Konga Logistics

Konga Logistics, formerly KXpress, delivers Konga's marketplace orders and other senders' parcels
across Nigeria. Tracked through the tracking page of logistics.konga.com.

## How it works

1. `direct`: one `GET https://logistics.konga.com/track?order_number={number}`. The page is
   rendered on the server: no cookie, form state, CAPTCHA or browser is needed.
2. `retry`: one more read after a network failure or a timeout. The first gets half of the budget.

- Only a page that names the number asked, under "Package Number" and beside the status tag, is
  read; a page for another number is indeterminate.
- A number the tracker does not know gets HTTP 200 and a page that echoes it over "We could not
  find this tracking number." Only that page is not found. A redirect or an error status, 404
  included, is a moved route; a bot check is a challenge; any other reply, such as the JSON the
  route gives without a number, is a schema failure.
- A page that names the shipment with no row is no history, with the reason `listed`.

## Notes

- Rows give a wall clock without a zone, so each keeps it in `local_time` and the catalog's Lagos
  clock dates it. A clock that does not read, or names the wrong weekday for its date, stays as
  text in `provider_time_text`.
- The page lists rows newest first. The adapter sorts them stably by clock, so rows of one minute,
  such as the shipment's creation and its receipt at the station, keep the page's order.
- The place is only in a row's sentence: the facility and town the parcel arrived at, was received
  or created at, or left. The adapter copies it to the location and keeps the sentence whole.
- [`status.ts`](status.ts) stages the rows by their sentences, whatever facility they name; other
  wording goes through the shared rules. The status tag over the rows decides only when no row has
  a stage, since the rows are finer: a parcel waiting at a Konga store for collection is
  `ready_for_pickup`.

## Limitations

- No delivery estimate, weight, service, sender or recipient.
- The tracker does not know the older public samples.
- Only the F shape has been seen on the tracker. Orders and KEXP waybills are looked up as typed.

## Numbers

A seller's shipment within a Konga order is F and twelve digits: the order's nine digits and a
line number. The order itself is R and nine digits, and a Konga Logistics waybill KEXP and sixteen
hexadecimal characters. F and twelve digits says nothing of Konga, and La Poste's rule takes the
shape too, so there is no detection rule: the carrier is chosen by hand. The sample and its source
are in [`numbers.json`](numbers.json).

## Links

`logistics.konga.com/track?order_number={number}` opens one shipment on the tracker. The search
page is the home page, with its tracking box.

## Testing

`KONGA_KXPRESS_TRACKING_NUMBER=… npm run test:carriers:live -- carriers/konga-kxpress`, with
`KONGA_KXPRESS_UNKNOWN_NUMBER` optionally set to a number the tracker does not know.
