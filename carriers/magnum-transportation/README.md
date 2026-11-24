# Magnum Transportation

Magnum Transportation shipments use enabled universal providers. There is no dedicated adapter.

Magnum Transportation (Magnum LTL) is a less-than-truckload and truckload freight carrier based in
Fargo, North Dakota. Its site is magnumlog.com.

## Numbers

Magnum Transportation publishes no PRO number format, and no public page shows one of its numbers,
so there is no rule.

## Why there is no adapter

Its Track Shipment form posts `type` (`BILL_NUMBER`, `2` for a Magnum pro bill, `3` for a C/L pro
bill, `B` for a bill of lading or `K` for a booking number) and `refnumber` to
`cs.magnumlog.com/quick-track.php`, which opens a results page with no address per number. That
page's script posts the same two fields to `cs.magnumlog.com/api-quick-track.php`, which answers
JSON without a login, cookie or CAPTCHA: the bill's header and its status history with offsets.
A number it does not hold gets a header with every field empty, which the page shows as "Freight
bill not found". A number can also bring back another bill, so a reply's `Bill_Number` must be the
number asked. No public number is known to check a found reply with.

## Links

No tracking link is known.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
