# SHENGAO

Tracks shipments of 盛傲物流 (深圳市盛傲国际物流有限公司, Shenzhen Shengao International Logistics),
a Shenzhen cross-border forwarder whose site is shengaoguojiwuliu.com, on its own tenant of the
Hualei (华磊) forwarder platform. Universal providers name it SHENGAO. The client is shared with
[GZYL](../gzyl/README.md), whose README describes the platform; this carrier keeps its host and
status map.

## How it works

1. `direct`: one GET to `selectTrack.htm?documentCode=<number>` on the tracker at
   `www.shengaoguojiwuliu.com:8082`, which the site's tracking box posts to, then, when the
   interface holds no row for the number, one POST of the same `documentCode` to the tracking page
   `trackIndex.htm`, which settles not-found ([hualei.ts](../gzyl/hualei.ts)).
2. `retry`: the same read once more after a request fails to reach the tracker or hangs.

The tracker answers plain HTTP only. No account, key, cookie, CAPTCHA or browser is needed.

## Notes

- The forwarder's own rows are its Shenzhen warehouse's receipt (`ARRIVAL`) and departure
  (`SHIPMENT`), in Chinese; they are shown in the English the platform's other tenants give them,
  and the map reads both. Between and after them the tracker copies the line's rows, from its
  Shenzhen sorting centre through the flights and customs, and the last-mile partner's in the
  destination country, all without a kind code.
- Every row is read on the platform's Beijing clock, the partner's copied rows too: the platform
  writes them hours after their clock, which on the destination's clock would still be ahead of
  the writing.
- The record's product name is the service name. Records name no channel or transfer number, so
  no delivering carrier is handed over. The tracker also finds a parcel by the shipper's
  reference, and then names the SHENGAO number.

## Limitations

The last-mile partner is not named and its number is never shown. No delivery estimate or
weight. HTTP recognition does not ask it.

## Numbers

No public source shows a whole SHENGAO number, and neither the site nor another public source
documents their layout, so detection offers SHENGAO for no number and the corpus is empty. The
carrier is chosen by hand, by a universal provider's carrier name, or from a link to its tracker.

## Links

The tracker's `trackIndex.htm?documentCode=` (also under `/en/`) opens one number, so a pasted
link to it names SHENGAO. Since the tracker is plain HTTP, no portal link is published, and the
canary checks 17TRACK, which the site links beside its tracking box.

## Testing

`SHENGAO_TRACKING_NUMBER=… npm run test:carriers:live -- carriers/shengao`, with the number set
outside the repository. The unknown-number case asks for an invented number, or
`SHENGAO_UNKNOWN_NUMBER` when set.
