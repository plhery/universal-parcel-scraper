# ED POST

Tracks shipments of ED POST (易德国际, 易德供应链有限公司), a Guangzhou cross-border forwarder whose
site is 666post.com and whose European lines hand parcels to GOFO in the Netherlands and DHL in
Germany, on its own tenant of the Hualei (华磊) forwarder platform. The client is shared with
[GZYL](../gzyl/README.md), whose README describes the platform; this carrier keeps its host, its
clocks and its status map.

## How it works

1. `direct`: one GET to `selectTrack.htm?documentCode=<number>` on the tracker at
   `www.666post.com:8082`, then, when the interface holds no row for the number, one POST of the
   same `documentCode` to the tracking page `trackIndex.htm`, which settles not-found
   ([hualei.ts](../gzyl/hualei.ts)).
2. `retry`: the same read once more after a request fails to reach the tracker or hangs.

The tracker answers plain HTTP only. No account, key, cookie, CAPTCHA or browser is needed.

## Notes

- The site's tracking page calls the same tracker through a proxy, `/sz56t/selectTrack.htm` on
  port 80, which answers byte for byte the same. The adapter asks the tracker the site's header
  links to, on port 8082, as every other tenant does, so the shared client needs no path prefix.
- The record's tracking number is the delivery carrier's, without a channel name: GOFO's on the
  line to the Netherlands, DHL's on the line to Germany. It is named only when that carrier's own
  rule claims the number whole. ED POST's own numbers start `YD` and end `YQ`.
- The forwarder's rows are on the platform's Beijing clock. The rows it copies from the delivery
  carrier keep that carrier's wall clock: GOFO's label row reads exactly seven hours before the
  order's registration. DHL's rows are dated on DHL's clock in Germany
  ([dhl-rows.ts](../gzyl/dhl-rows.ts)); GOFO's keeps its wall clock alone.
- The tracker glues its own status to the end of DHL's sentences (`…to DHLtransit`); it is dropped.
- The booked flight's departure (`Estimated flight departure time (ETD: …)`) and DHL's
  preferred-neighbour row are notices: they keep the stage of the scan before them.
- The tracker writes the spaces of its registration row as question marks; the shared cleaning
  reads them back as spaces.
- The record's product name is the service name and its destination the destination country.

## Limitations

GOFO's and DHL's later scans come only as far as the tracker copies them. No delivery estimate or
weight.

## Numbers

The samples come from a tracking directory's Yide International page. No detection rule claims
ED POST's layout yet.

## Links

The tracker's `trackIndex.htm?documentCode=` opens one number, on port 8082 or through the site's
`/sz56t` proxy. Since the tracker is plain HTTP, no portal link is published, and the canary checks
17TRACK instead.

## Testing

`ED_POST_TRACKING_NUMBER=… npm run test:carriers:live -- carriers/ed-post`, with the number set
outside the repository. The unknown-number case asks for an invented number, or
`ED_POST_UNKNOWN_NUMBER` when set.
