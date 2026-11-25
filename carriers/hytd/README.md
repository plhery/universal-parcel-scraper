# HYTD Express

Tracks shipments of HYTD Express (浩源拓达, 浩源物流, 深圳市浩源拓达物流有限公司), a Shenzhen
cross-border forwarder whose site is www.hytdexpress.com and whose US line hands parcels on for
USPS to deliver, on its own tenant of the Hualei (华磊) forwarder platform. The client is shared
with [GZYL](../gzyl/README.md), whose README describes the platform; this carrier keeps its host,
its clocks and its status map.

## How it works

1. `direct`: one GET to `selectTrack.htm?documentCode=<number>` on the tracker at
   `159.75.218.197:8082`, the address of the site header's parcel-customer registration and login
   links, then, when the interface holds no row for the number, one POST of the same
   `documentCode` to the tracking page `trackIndex.htm`, which settles not-found
   ([hualei.ts](../gzyl/hualei.ts)). The site's own tracking query opens 17TRACK.
2. `retry`: the same read once more after a request fails to reach the tracker or hangs.

The tracker answers plain HTTP only, on a bare address. No account, key, cookie, CAPTCHA or browser
is needed.

## Notes

- Once the delivering carrier's number takes the record's tracking number, HYTD's own number stays
  in the invoice field. That number, of a carrier the record does not name, is the delivery
  tracking number. HYTD's own numbers start `HY` and end `TD`.
- The line's own rows, placed at `US`, at its own `HY` or nowhere, are on the platform's Beijing
  clock, the flight's landing written to the minute included. A row placed at a town or a facility
  before `US` is one the tracker copies from USPS and keeps its wall clock: read on Beijing's,
  USPS's delivery would fall in the night before. `HY` names no place and is dropped.
- The record's product name is the service name and its destination the destination country.

## Limitations

The record does not name the carrier whose number it holds, so the parcel is handed to none. USPS's
rows keep their wall clock without an instant. No delivery estimate or weight.

## Numbers

The sample comes from a tracking directory's HYTD page. No detection rule claims the layout yet.

## Links

The tracker's `trackIndex.htm?documentCode=` opens one number. Since the tracker is plain HTTP on a
bare address, no portal link is published, and the canary checks 17TRACK instead.

## Testing

`HYTD_TRACKING_NUMBER=… npm run test:carriers:live -- carriers/hytd`, with the number set outside
the repository. The unknown-number case asks for an invented number, or `HYTD_UNKNOWN_NUMBER` when
set.
