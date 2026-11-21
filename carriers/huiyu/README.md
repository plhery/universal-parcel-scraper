# Huiyu International

Tracks shipments of Huiyu International (辉宇国际, 深圳市辉宇国际货运代理有限公司), a Shenzhen
forwarder whose site is hygjlog.com, on its lines for small parcels to the United States,
Europe, the United Kingdom and Canada. 17TRACK names it `HYGJWL`.

## How it works

The site links Huiyu's own tenant of the Hualei (华磊) platform, which answers at
`81.71.24.16:8082` over plain HTTP. The adapter is the platform's
([hualei.ts](../gzyl/hualei.ts)) with this carrier's host and status map:

1. `direct`: one GET to `selectTrack.htm?documentCode=<number>`, then, when the interface holds no
   row for the number, one POST of the same `documentCode` to `trackIndex.htm`, which settles
   not-found.
2. `retry`: the same read once more after a request fails to reach the tracker or hangs.

Recognition asks the same lookup: a row says Huiyu holds the number.

## Notes

- The platform writes its order row in Chinese, which the adapter shows in English, and the
  receiving point's scan in Chinese and English in one row. Rows are read on the platform's
  Beijing clock.
- A record keeps Huiyu's own number in its invoice field and the delivery carrier's in its
  tracking number, with no channel named. On the line to the United Kingdom that is Royal Mail's
  number, which Royal Mail's own rule claims whole, so the result names Royal Mail with it.

## Limitations

- Only Royal Mail is named as a delivery carrier: the carriers of the other lines have not been
  seen.

## Numbers

Huiyu's waybills are `HY`, thirteen digits and `YQ`, a suffix many forwarders' systems share
behind their own prefixes. Two letters say little, so the rule is low and recognition asks the
tracker. No public number has been found, so the corpus holds a synthetic one.

## Links

The tracker is plain HTTP only, so the catalog links no page of it. The canary takes HTTPS only,
so it checks 17TRACK, which the site links to.

## Testing

Set `HUIYU_TRACKING_NUMBER` (and `HUIYU_UNKNOWN_NUMBER` for the not-found answer) outside the
repository and run `npm run test:carriers:live -- carriers/huiyu`.
