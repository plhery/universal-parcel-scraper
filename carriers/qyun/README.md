# Qyun Express

Tracks shipments of Qyun Express (青云物流, 深圳市青云物流供应链管理有限公司), a Shenzhen
cross-border forwarder whose site is www.qyunexpress.com and whose lines to Mexico hand parcels to
iMile, on its own tenant of the Hualei (华磊) forwarder platform. The client is shared with
[GZYL](../gzyl/README.md), whose README describes the platform; this carrier keeps its host, its
clocks and its status map.

## How it works

1. `direct`: one GET to `selectTrack.htm?documentCode=<number>` on the tracker at
   `106.52.192.65:8082`, where the site's login and tracking links point, then, when the interface
   holds no row for the number, one POST of the same `documentCode` to the tracking page
   `trackIndex.htm`, which settles not-found ([hualei.ts](../gzyl/hualei.ts)).
2. `retry`: the same read once more after a request fails to reach the tracker or hangs.

The tracker answers plain HTTP only, on a bare address. No account, key, cookie, CAPTCHA or browser
is needed.

## Notes

- The lookup matches the record's tracking number, which on the Mexico lines is iMile's waybill,
  the forwarder's own waybill in the invoice field, or the shipper's reference. iMile's tracker
  holds the same number with the same scans.
- Rows are on the platform's Beijing clock, iMile's copied ones included: iMile dates the same
  delivery fourteen hours earlier on Mexico's clock, and its order record comes a second after the
  platform's registration. The line's airport and customs rows, written by hand on the whole hour,
  give their day alone: they fall on midnight, or are written in the morning for noon and the
  afternoon at Hong Kong.
- iMile's copied rows open with its category, `scan` or `submitted`, which is dropped. iMile's feed
  writes the warehouse's receipt again without its kind code at the same clock; that copy goes. Its
  warehouse, centre or station named in `【…】` is read as an ellipsis by the status map.
- `Abnormal LT` is iMile's abnormal scan at its Mexico City centre, weeks after the parcel's last
  movement and with no delivery round; the record then says the forwarder paid compensation. It
  maps to an exception.
- The record's product name is the service name and its destination the destination country.

## Limitations

The record does not name iMile, and no detection rule ties iMile's waybill to iMile with enough
confidence, so the parcel is not handed to iMile. No delivery estimate or weight.

## Numbers

The samples come from three captures of a tracking directory's Qyun page and are iMile's waybills.
No detection rule claims a Qyun Express layout.

## Links

The tracker's `trackIndex.htm?documentCode=` opens one number. Since the tracker is plain HTTP on a
bare address, no portal link is published, and the canary checks 17TRACK instead.

## Testing

`QYUN_TRACKING_NUMBER=… npm run test:carriers:live -- carriers/qyun`, with the number set outside
the repository. The unknown-number case asks for a number in a shape the tracker cannot hold, or
`QYUN_UNKNOWN_NUMBER` when set.
