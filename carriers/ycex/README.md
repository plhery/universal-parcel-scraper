# YCEX

Tracks shipments of YCEX (永财国际物流, 广州永财国际供应链有限公司), a Guangzhou forwarder whose
site is ycex-cn.com, on its own tenant of the Hualei (华磊) forwarder platform. The client is shared
with [GZYL](../gzyl/README.md), whose README describes the platform; this carrier keeps its host and
its status map, and reads DHL's rows as [Suoexpress](../suocang/README.md) does.

## How it works

1. `direct`: one GET to `selectTrack.htm?documentCode=<number>` on the tracker at
   `159.75.78.252:8082`, the address of the site's tracking link, then, when the interface holds no
   row for the number, one POST of the same `documentCode` to the tracking page `trackIndex.htm`,
   which settles not-found ([hualei.ts](../gzyl/hualei.ts)).
2. `retry`: the same read once more after a request fails to reach the tracker or hangs.

The tracker answers plain HTTP only, on a bare address. No account, key, cookie, CAPTCHA or browser
is needed.

## Notes

- On the European line the parcel flies into Amsterdam and DHL delivers it in Germany. The tracker
  copies DHL's sentences on DHL's wall clock where it scanned the parcel; they are dated on that
  clock by the same rule as Suoexpress's ([dhl-rows.ts](../gzyl/dhl-rows.ts)), and keep it. The
  platform's own rows are on its Beijing clock.
- DHL's number is in no field and no row, so the parcel is not handed on.
- Rows in Chinese and English are kept as written. Rows in Chinese alone are shown in English; the
  flight rows name a day of the month, which the map reads as an ellipsis and the English gives as
  an ordinal.
- The record's product name is the service name and its destination the destination country.

## Limitations

No delivery carrier, delivery estimate or weight.

## Numbers

The sample comes from a tracking directory's YCEX page. No detection rule claims the layout yet.

## Links

The tracker's `trackIndex.htm?documentCode=` opens one number. Since the tracker is plain HTTP on a
bare address, no portal link is published, and the canary checks 17TRACK instead.

## Testing

`YCEX_TRACKING_NUMBER=… npm run test:carriers:live -- carriers/ycex`, with the number set outside
the repository. The unknown-number case asks for a string in no shape the tracker issues, or
`YCEX_UNKNOWN_NUMBER` when set.
