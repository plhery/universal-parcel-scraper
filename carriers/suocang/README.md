# Suoexpress

Tracks shipments of Suoexpress (SUOCANG, 所仓物流, 深圳市所仓国际物流有限公司), a Shenzhen
cross-border forwarder whose site is suoexpress.com and whose European line flies parcels to Germany
for DHL to deliver, on its own tenant of the Hualei (华磊) forwarder platform. The client is shared
with [GZYL](../gzyl/README.md), whose README describes the platform; this carrier keeps its host,
its clocks and its status map.

## How it works

1. `direct`: one GET to `selectTrack.htm?documentCode=<number>` on the tracker at
   `42.193.237.14:8082`, the address of the site menu's "小包登陆" item, then, when the interface
   holds no row for the number, one POST of the same `documentCode` to the tracking page
   `trackIndex.htm`, which settles not-found ([hualei.ts](../gzyl/hualei.ts)).
2. `retry`: the same read once more after a request fails to reach the tracker or hangs.

The tracker answers plain HTTP only, on a bare address. No account, key, cookie, CAPTCHA or browser
is needed.

## Notes

- The line's own rows, placed at its Shenzhen warehouse (`SZS`) or nowhere, are on the platform's
  Beijing clock.
- The rows the tracker copies from DHL are on DHL's clock where DHL scanned the parcel: a town's
  when one is named, else Germany's ([dhl-rows.ts](../gzyl/dhl-rows.ts)).
- The rows from the warehouse to the import clearance come from the platform's custom track product
  (`CO_C_CR`). They are named as written ahead and listed as planned steps, not kept as scans.
  [status.ts](status.ts) still maps them.
- `Loaded to movement / tour vehicle` is DHL's wording for a trunk run and a delivery round alike,
  so the map reads it as in transit.
- The record's product name is the service name and its destination the destination country.

## Limitations

The record does not give DHL's number, so the parcel is not handed to DHL. No delivery estimate or
weight.

## Numbers

The sample comes from a tracking directory's SUOCANG page. No detection rule claims the layout yet.

## Links

The tracker's `trackIndex.htm?documentCode=` opens one number. Since the tracker is plain HTTP on a
bare address, no portal link is published, and the canary checks 17TRACK instead.

## Testing

`SUOCANG_TRACKING_NUMBER=… npm run test:carriers:live -- carriers/suocang`, with the number set
outside the repository. The unknown-number case asks for a string in no shape the tracker issues, or
`SUOCANG_UNKNOWN_NUMBER` when set.
