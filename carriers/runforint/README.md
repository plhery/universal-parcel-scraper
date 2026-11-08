# Runforint Logistics

Runforint Logistics parcels use enabled universal providers. There is no dedicated adapter.

Runforint Logistics (润峯物流, RFL) is a cross-border e-commerce consolidator in Suzhou, China. It
ships sellers' parcels by international express with UPS, DHL and ePacket, on its own dedicated
lines, by air, sea, China-Europe rail and truck, and runs overseas warehouses. Its site is
runforint.com.

## Numbers

No public page shows a Runforint number, so there is no rule.

## Why there is no adapter

Its tracking page posts up to 20 numbers to `index.php?m=home&c=index&a=waybill_track` as Base64
JSON, signed with an MD5 over the fields and a static key from the page script, and reads JSON
with each number's scans. No public number is known to see a found reply.

## Links

`www.runforint.com/index.php?m=home&c=Lists&a=index&tid=137&key=<number>` opens one parcel: the
page reads `key` and runs the search. The rule requires `tid=137`, the tracking page, because the
whole site shares `index.php`.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
