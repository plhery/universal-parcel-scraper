# Runforint Logistics

Runforint Logistics (润峯物流, RFL) is a cross-border e-commerce consolidator in Suzhou, China. It
ships sellers' parcels by international express with UPS, DHL and ePacket, on its own dedicated
lines, by air, sea, China-Europe rail and truck, and runs overseas warehouses. Its site is
runforint.com. Tracked through the lookup behind its tracking page.

## How it works

1. `direct`: one `POST https://www.runforint.com/index.php?m=home&c=index&a=waybill_track`, the
   call the tracking page makes. It sends the number as Base64 JSON with the time and a fresh
   message id, signed with an MD5 over those fields and the key the page's script gives every
   visitor. It needs no cookie, account or browser.
2. `retry`: one more request when the first fails to reach the site or hangs. The first gets
   half of the budget, so the retry fits in the rest.

- A number with no waybill is HTTP 200 with `"Code":"E1"` and "the system has no record of the
  number", which is not found. `E1` with "request limit exceeded", the answer to a lookup sent
  within a second or so of another, is a rate limit. Any other message is inconclusive, and a
  404 or a redirect is a moved route.
- Only the entry whose `ShipmentNo` is the whole number asked is read.
- The tracking page looks up the number in its `key` parameter, which the catalog's link uses.

## Notes

- The service lists scans oldest first, each a wall clock with its zone field empty, so scans keep
  `local_time`. The result orders them newest first by that clock, as the page does.
- Each scan carries the service's status number, mapped in [`statuses.json`](statuses.json) where
  seen; other scans go through the shared wording rules.
- The destination reads as the ISO code in brackets after its Chinese name. The merchant's name
  is not kept.

## Limitations

- No delivery estimate, weight or onward carrier.

## Numbers

The public waybills are RF and twelve digits, from one series. Two samples are too few to tell
that series from other carriers' numbers, so no rule claims it and the adapter answers explicit
selection. The samples and their source are in [`numbers.json`](numbers.json).

## Testing

`RUNFORINT_TRACKING_NUMBER=… RUNFORINT_UNKNOWN_NUMBER=… npm run test:carriers:live -- carriers/runforint`
