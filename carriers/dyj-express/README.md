# DYJ Express

Tracks shipments of DYJ Express (深圳达运佳国际物流, Shenzhen Dayunjia International Logistics), a
Shenzhen forwarder, on its US line, where USPS delivers.

## How it works

The firm's site, www.dyjexp.com, no longer serves it, but its
[archived tracking page](https://web.archive.org/web/20260214223727/http://www.dyjexp.com/search.html)
opened DYJ's own tenant of the Hualei (华磊) platform at `43.138.180.250:8082`, over plain HTTP,
which still answers. The adapter is the platform's ([hualei.ts](../gzyl/hualei.ts)) with this
carrier's host, clocks, hand-off and status map:

1. `direct`: one GET to `selectTrack.htm?documentCode=<number>`, then, when the interface holds no
   row for the number, one POST of the same `documentCode` to `trackIndex.htm`, which settles
   not-found.
2. `retry`: the same read once more after a request fails to reach the tracker or hangs.

Recognition asks the same lookup: a row says DYJ holds the number.

## Notes

- The record gives USPS's number as the channel's transfer number, without a channel name. USPS
  is named as the delivery carrier with that number when USPS's own rule claims it whole and no
  channel names another carrier. The lookup also finds the record by USPS's number.
- The tracker copies USPS's scans to the minute on the facility's clock, which it does not name:
  those rows keep their wall clock, and a midnight row its day alone, as on Kun Express's tracker.
  The line's own rows come to the second on the platform's Beijing clock.
- The line's warehouse, flight and clearance rows are the platform's custom track rows
  (`CO_C_CR`), written by script: they are held back as written ahead and listed as planned steps,
  as on every Hualei tenant.
- Place fields carry US ZIP codes, which the shared cleaning drops.

## Limitations

- USPS's rows have no instant: the tracker gives their wall clock without its zone.

## Numbers

DYJ's waybills have `DYJCN`, ten digits and `CN`, the firm's initials around China's code, as
TrackShip's example shows. No other carrier's rule or sample has the layout, so the rule names DYJ
Express with high confidence.

## Links

The tracker is plain HTTP only, so the catalog links no page of it, and the canary checks 17TRACK.
A pasted link to the tracker's `trackIndex.htm` is read for its number.

## Testing

Set `DYJ_EXPRESS_TRACKING_NUMBER` (and `DYJ_EXPRESS_UNKNOWN_NUMBER` for the not-found answer)
outside the repository and run `npm run test:carriers:live -- carriers/dyj-express`.
