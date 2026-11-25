# Wokexp

Tracks shipments of Wokexp (威龙永凯, 威龙永凯供应链管理（上海）有限公司), a Shanghai cross-border
forwarder whose site is wokexp.cn and whose line to Italy flies parcels to Amsterdam for Poste
Italiane to deliver, on its own tenant of the Hualei (华磊) forwarder platform. The client is shared
with [GZYL](../gzyl/README.md), whose README describes the platform; this carrier keeps its host,
its clocks and its status map.

## How it works

1. `direct`: one GET to `selectTrack.htm?documentCode=<number>` on the tracker at
   `www.wokexp.cn:8082`, whose `trackIndex.htm` the site's tracking form posts to, then, when the
   interface holds no row for the number, one POST of the same `documentCode` to that page, which
   settles not-found ([hualei.ts](../gzyl/hualei.ts)).
2. `retry`: the same read once more after a request fails to reach the tracker or hangs.

The tracker answers plain HTTP only. No account, key, cookie, CAPTCHA or browser is needed.

## Notes

- The line's own rows, the landing at Amsterdam included, are on the platform's Beijing clock.
  The rows the tracker copies from Poste Italiane, in Italian, keep Italy's wall clock: read on
  Beijing's, the parcel would go out for delivery at four in the morning in Italy.
- Poste Italiane gives a scan twice, its category alone and followed by its sentence
  (`In consegna, la spedizione è in consegna`). At one clock and place, the longer row is that
  scan again and counts once.
- The record's invoice number is Poste Italiane's, in no transfer field. Poste Italiane's own rule
  claims it whole, so the parcel is handed to Poste Italiane under it, and the lookup finds the
  record by it too.
- The record's product name is the service name and its destination the destination country.

## Limitations

Poste Italiane's rows keep their wall clock without an instant. No delivery estimate or weight.

## Numbers

The sample comes from a tracking directory's Wokexp page. No detection rule claims Wokexp's layout
yet.

## Links

The tracker's `trackIndex.htm?documentCode=` opens one number. Since the tracker is plain HTTP, no
portal link is published, and the canary checks 17TRACK instead.

## Testing

`WOKEXP_TRACKING_NUMBER=… npm run test:carriers:live -- carriers/wokexp`, with the number set
outside the repository. The unknown-number case asks for an invented number, or
`WOKEXP_UNKNOWN_NUMBER` when set.
