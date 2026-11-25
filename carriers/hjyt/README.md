# Hengjie Yutong

Tracks shipments of Hengjie Yutong (恒捷宇通, HJYT, 深圳市恒捷宇通物流有限公司), a Shenzhen
cross-border forwarder whose site is www.hjyt56.com and whose line to the United Arab Emirates hands
parcels to iMile, on its own tenant of the Hualei (华磊) forwarder platform. The client is shared
with [GZYL](../gzyl/README.md), whose README describes the platform; this carrier keeps its host,
its clocks and its status map.

## How it works

1. `direct`: one GET to `selectTrack.htm?documentCode=<number>` on the tracker at
   `120.78.64.88:8082`, where the site's tracking form, login and registration links point, then,
   when the interface holds no row for the number, one POST of the same `documentCode` to the
   tracking page `trackIndex.htm`, which settles not-found ([hualei.ts](../gzyl/hualei.ts)).
2. `retry`: the same read once more after a request fails to reach the tracker or hangs.

The tracker answers plain HTTP only, on a bare address. No account, key, cookie, CAPTCHA or browser
is needed.

## Notes

- The lookup matches the record's tracking number, which on the Emirates line is iMile's waybill,
  the forwarder's own waybill in the invoice field, or the shipper's reference. iMile's tracker
  holds the same number with the same scans.
- The warehouse's rows, which carry a kind code, and the order's registration, placed nowhere, are
  on the platform's Beijing clock. The rows copied from iMile, placed at its centres, its station or
  the destination country, keep iMile's wall clock in the Emirates: iMile's order record comes two
  seconds after the platform's registration on a clock four hours behind Beijing's.
- The tracker writes the place again ahead of iMile's category, as `AUH DS Delivered,…` at `AUH DS`;
  the repeated place is dropped. iMile's centre or station named in `【…】` is read as an ellipsis by
  the status map.
- The record does not name iMile, and iMile's thirteen digits are a shape it shares with other
  carriers, which no rule ties to iMile with high confidence. The record is handed to iMile when
  iMile's detection offers its tracking number, iMile serves the destination and a row is a copy
  of iMile's, which carries no kind code and names iMile's centre or station in `【…】`.
- The record's product name is the service name and its destination the destination country.

## Limitations

iMile's rows keep their wall clock without an instant. No delivery estimate or weight.

## Numbers

The sample comes from a tracking directory's HJYT page and is iMile's waybill. No detection rule
claims a Hengjie Yutong layout.

## Links

The tracker's `trackIndex.htm?documentCode=` opens one number. Since the tracker is plain HTTP on a
bare address, no portal link is published, and the canary checks 17TRACK instead.

## Testing

`HJYT_TRACKING_NUMBER=… npm run test:carriers:live -- carriers/hjyt`, with the number set outside
the repository. The unknown-number case asks for a number in a shape the tracker cannot hold, or
`HJYT_UNKNOWN_NUMBER` when set.
