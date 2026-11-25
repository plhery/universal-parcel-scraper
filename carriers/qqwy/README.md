# Global Security

Tracks shipments of Global Security (全球无忧, QQWY, 深圳市全球无忧国际物流有限公司), a Shenzhen
cross-border forwarder whose site is www.qqwy56.com and whose US lines hand parcels to SpeedX or
UniUni, on its own tenant of the Hualei (华磊) forwarder platform. The client is shared with
[GZYL](../gzyl/README.md), whose README describes the platform; this carrier keeps its host, its
clocks and its status map.

## How it works

1. `direct`: one GET to `selectTrack.htm?documentCode=<number>` on the tracker at
   `www.qqwy56.com:8082`, where the site's login, registration and price forms point, then, when the
   interface holds no row for the number, one POST of the same `documentCode` to the tracking page
   `trackIndex.htm`, which settles not-found ([hualei.ts](../gzyl/hualei.ts)).
2. `retry`: the same read once more after a request fails to reach the tracker or hangs.

The tracker answers plain HTTP only. No account, key, cookie, CAPTCHA or browser is needed.

## Notes

- The lookup matches the forwarder's own number, its line's waybill, the shipper's reference or the
  last-mile carrier's number, which the record holds as its transfer number without naming the
  carrier. SpeedX or UniUni takes that number when its own high-confidence rule claims it whole. The
  line also names the number in a row, read as a notice; it hands the parcel on when the record has
  no transfer number.
- The line's own rows, in China, at the airports and at its US gateway, are on the platform's
  Beijing clock. The rows copied from the last-mile carrier, placed at a US town, keep their wall
  clock: on Beijing's, SpeedX's would come twelve hours before the platform writes them rather than
  within the hour, and UniUni's would predate polls that missed them.
- The rows of the line's supplier carry a Chinese copy, which is dropped. They keep their wall clock
  too: the supplier's receipt of an order comes eight hours and a second after UniUni's, the same
  moment on another clock, which the record does not name.
- SpeedX's delivery names where the parcel was left and UniUni's failed attempt its reason; the
  status map reads both as an ellipsis. The warehouse's Chinese rows are shown in English.
- The record's product name is the service name and its destination the destination country.

## Limitations

The copied rows keep their wall clock without an instant. No delivery estimate or weight.

## Numbers

The samples come from two captures of a tracking directory's QQWY page. No detection rule claims the
layout yet.

## Links

The tracker's `trackIndex.htm?documentCode=` opens one number. Since the tracker is plain HTTP, no
portal link is published, and the canary checks 17TRACK instead.

## Testing

`QQWY_TRACKING_NUMBER=… npm run test:carriers:live -- carriers/qqwy`, with the number set outside
the repository. The unknown-number case asks for a number in a shape the tracker cannot hold, or
`QQWY_UNKNOWN_NUMBER` when set.
