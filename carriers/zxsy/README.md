# ZXSY

Tracks shipments of ZXSY (甄兴盛越, ZhenXingshengyue, 甄兴盛越国际物流(莆田)有限公司), a Putian
cross-border forwarder whose site is www.zxsywl.cn and whose European line flies parcels to Oslo
for Helthjem to deliver in Norway, on its own tenant of the Hualei (华磊) forwarder platform. The
client is shared with [GZYL](../gzyl/README.md), whose README describes the platform; this carrier
keeps its host, its clocks and its status map.

## How it works

1. `direct`: one GET to `selectTrack.htm?documentCode=<number>` on the tracker at
   `www.zxsywl.cn:8082`, the host the site's login, registration and price forms post to, then,
   when the interface holds no row for the number, one POST of the same `documentCode` to the
   tracking page `trackIndex.htm`, which settles not-found ([hualei.ts](../gzyl/hualei.ts)).
2. `retry`: the same read once more after a request fails to reach the tracker or hangs.

The tracker answers plain HTTP only. No account, key, cookie, CAPTCHA or browser is needed.

## Notes

- Once Helthjem takes the parcel, its SSCC takes the record's tracking number, without a channel
  name, and ZXSY's own number stays in the invoice field. The SSCC is named Helthjem's only when
  Helthjem's rule claims it whole. ZXSY's own numbers start `ZXSY` and end `CN`.
- The line's own rows, placed at a country, in China or nowhere, are on the platform's Beijing
  clock. From the first row placed abroad on, a row at a town, a depot or an airport is one the
  tracker copies from Oslo's handler or Helthjem, and keeps its wall clock: Helthjem's own tracker
  dates those scans at the same wall clocks.
- Helthjem's feed adds bare status codes beside its worded scans (`DELIVERED`,
  `ITEM_AT_DELIVERY_DEPOT`, `RELEASED_FROM_CUSTOMS`, `INFO`). Each repeats a worded scan of the
  same feed, on that scan's wall clock read as UTC, so it is dropped.
- `Parcel activated` is Helthjem's booking of the night round, which Helthjem's own adapter stages
  in transit: no courier has the parcel yet.
- The booked flight's days (`Flight ETD Jun 4.`, `Flight ETA Jun 6.`) are notices: they keep the
  stage of the scan before them. The day in these rows and in `The flight has departed Jun 5.` is
  read as an ellipsis.
- The warehouse's Chinese rows are shown in English. The tracker loses `Ø` in Norwegian places.
- The record's product name is the service name and its destination the destination country.

## Limitations

Helthjem's later scans come only as far as the tracker copies them. The rows abroad keep their
wall clock without an instant. No delivery estimate or weight.

## Numbers

The sample comes from a tracking directory's ZXSY page. No detection rule claims ZXSY's layout yet.

## Links

The tracker's `trackIndex.htm?documentCode=` opens one number. Since the tracker is plain HTTP, no
portal link is published, and the canary checks 17TRACK instead.

## Testing

`ZXSY_TRACKING_NUMBER=… npm run test:carriers:live -- carriers/zxsy`, with the number set outside
the repository. The unknown-number case asks for an invented number, or `ZXSY_UNKNOWN_NUMBER` when
set.
