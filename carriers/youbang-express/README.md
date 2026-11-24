# YouBang Express

Tracks shipments of 佑邦国际物流 (深圳市佑邦国际物流有限公司, Shenzhen Youbang International
Logistics), a Shenzhen cross-border forwarder whose site is youbangexpress.com, on its own tenant of
the Hualei (华磊) forwarder platform. Universal providers name it YBWL. The client is shared with
[GZYL](../gzyl/README.md), whose README describes the platform; this carrier keeps its host and
status map.

## How it works

1. `direct`: one GET to `selectTrack.htm?documentCode=<number>` on the tracker at
   `119.29.254.121:8082`, which the site's tracking page frames, then, when the interface holds no
   row for the number, one POST of the same `documentCode` to the tracking page `trackIndex.htm`,
   which settles not-found ([hualei.ts](../gzyl/hualei.ts)).
2. `retry`: the same read once more after a request fails to reach the tracker or hangs.

The tracker answers plain HTTP only, on a bare address. No account, key, cookie, CAPTCHA or
browser is needed.

## Notes

- The forwarder's own rows are its Shenzhen warehouse's receipt (`ARRIVAL`) and departure
  (`SHIPMENT`), in Chinese, at a place written as "."; that place is read as none. They are on the
  platform's Beijing clock.
- The rows after the departure, from export clearance to the delivery, come from the platform's
  custom track product (`CO_C_CR`). As on every tenant, they are named as written ahead and listed
  as planned steps, not kept as scans. [status.ts](status.ts) still maps them, and reads the
  flight row the same whatever airport code leads it.
- The record's product name is the service name. Records name no channel or transfer number, so
  no delivering carrier is handed over. The tracker also finds a parcel by the shipper's
  reference, and then names the YouBang number.

## Limitations

A parcel's history holds the warehouse's two scans. The delivering carrier and its number are
never shown. No delivery estimate or weight.

## Numbers

No public source shows a whole YouBang Express number. A parcel a universal provider files under
YBWL has `YB`, ten digits and `CN`, so a low rule suggests YouBang Express for that layout; the
corpus holds a made-up number in that shape. Other Shenzhen and Guangdong forwarders share the
initials, so the rule stays low.

## Links

The tracker's `trackIndex.htm?documentCode=` opens one number. Since the tracker is plain HTTP on
a bare address, no portal link is published, and the canary checks 17TRACK instead.

## Testing

`YOUBANG_EXPRESS_TRACKING_NUMBER=… npm run test:carriers:live -- carriers/youbang-express`, with
the number set outside the repository. The unknown-number case asks for an invented number, or
`YOUBANG_EXPRESS_UNKNOWN_NUMBER` when set.
