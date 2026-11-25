# Lightning Monkey

Tracks shipments of Lightning Monkey (闪电猴跨境物流, SDH Express, 浙江闪电猴供应链有限公司), a Yiwu
cross-border forwarder whose site is sdh-express.com, on its own tenant of the Hualei (华磊)
forwarder platform. The client is shared with [GZYL](../gzyl/README.md), whose README describes the
platform; this carrier keeps its host and its status map.

## How it works

1. `direct`: one GET to `selectTrack.htm?documentCode=<number>` on the tracker at
   `182.254.152.160:8082`, the address of the site's "全程追踪" link, then, when the interface holds
   no row for the number, one POST of the same `documentCode` to the tracking page
   `trackIndex.htm`, which settles not-found ([hualei.ts](../gzyl/hualei.ts)).
2. `retry`: the same read once more after a request fails to reach the tracker or hangs.

The tracker answers plain HTTP only, on a bare address. No account, key, cookie, CAPTCHA or browser
is needed.

## Notes

- Every row comes to the second on the platform's Beijing clock, the ones in the United States too.
- The rows from the warehouse to the export clearance come from the platform's custom track product
  (`CO_C_CR`), and the flight's departure and landing are written days before their clocks. They are
  named as written ahead and listed as planned steps, not kept as scans.
- The rows in the United States name neither the delivering carrier nor its number, so the parcel
  is not handed on; `The post office is in operation` and `The delivery company is processing it`
  read as transit, not as a delivery round.
- The record's product name is the service name and its destination the destination country.

## Limitations

No delivery carrier, delivery estimate or weight.

## Numbers

The sample comes from a tracking directory's SDH Express page. No detection rule claims the layout
yet.

## Links

The tracker's `trackIndex.htm?documentCode=` opens one number. Since the tracker is plain HTTP on a
bare address, no portal link is published, and the canary checks 17TRACK instead.

## Testing

`SDH_EXPRESS_TRACKING_NUMBER=… npm run test:carriers:live -- carriers/sdh-express`, with the number
set outside the repository. The unknown-number case asks for a string in no shape the tracker
issues, or `SDH_EXPRESS_UNKNOWN_NUMBER` when set.
