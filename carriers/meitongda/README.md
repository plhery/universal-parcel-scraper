# MEITONGDA

Tracks shipments of MEITONGDA (美通达, 深圳市美通达跨境供应链有限公司), a Shenzhen cross-border
forwarder whose site is metooda.cn, on its own tenant of the Hualei (华磊) forwarder platform. The
client is shared with [GZYL](../gzyl/README.md), whose README describes the platform; this carrier
keeps its host, its clocks and its status map.

## How it works

1. `direct`: one GET to `selectTrack.htm?documentCode=<number>` on the tracker at
   `119.91.196.60:8082`, where the site's tracking form, login and price links point, then, when the
   interface holds no row for the number, one POST of the same `documentCode` to the tracking page
   `trackIndex.htm`, which settles not-found ([hualei.ts](../gzyl/hualei.ts)).
2. `retry`: the same read once more after a request fails to reach the tracker or hangs.

The tracker answers plain HTTP only, on a bare address. No account, key, cookie, CAPTCHA or browser
is needed.

## Notes

- On the line to Britain the record copies the airport's and the delivering network's scans under
  the forwarder's own number. It names no channel, transfer number or other carrier, so nothing is
  handed on.
- Rows placed abroad, the airport's and the delivering network's copies, keep their station's wall
  clock: on Beijing's clock the Belfast delivery office would go out before dawn, and the page heads
  the clock column 当地时间 (local time). The rows placed nowhere, the order's and the line's in
  China, are on the platform's Beijing clock.
- The tracker drops every lower-case "g" from the line's English ("Packa ed", "Leavin Scan"). The
  map lists the wording as it comes, and the scans show it so.
- The record's product name is the service name and its destination the destination country.

## Limitations

Rows abroad keep their wall clock without an instant. No delivery estimate or weight.

## Numbers

The sample comes from a tracking directory's MEITONGDA page. No detection rule claims a MEITONGDA
layout.

## Links

The tracker's `trackIndex.htm?documentCode=` opens one number. Since the tracker is plain HTTP on a
bare address, no portal link is published, and the canary checks 17TRACK instead.

## Testing

`MEITONGDA_TRACKING_NUMBER=… npm run test:carriers:live -- carriers/meitongda`, with the number set
outside the repository. The unknown-number case asks for a string in no shape the tracker issues, or
`MEITONGDA_UNKNOWN_NUMBER` when set.
