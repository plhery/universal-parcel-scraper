# JYTWL

Tracks shipments of JYTWL (广州玖运通国际物流服务有限公司, Guangzhou Jiuyuntong International
Logistics), a Guangzhou forwarder, on its own tracker, from its warehouse to the destination post's
delivery.

## How it works

The [tracking page](http://jiuyuntong.cn/cx.html) on the firm's site frames JYTWL's own tenant of
the Hualei (华磊) platform at `118.195.157.162:8082`, over plain HTTP. The adapter is the platform's
([hualei.ts](../gzyl/hualei.ts)) with this carrier's host, clocks, text and status map:

1. `direct`: one GET to `selectTrack.htm?documentCode=<number>`, then, when the interface holds no
   row for the number, one POST of the same `documentCode` to `trackIndex.htm`, which settles
   not-found.
2. `retry`: the same read once more after a request fails to reach the tracker or hangs.

Recognition asks the same lookup: a row says JYTWL holds the number.

## Notes

- The line's own rows, with a kind code, placed in Chinese or nowhere, or worded in Chinese, are
  read on the platform's Beijing clock. The rows it copies from Europe, worded in English or
  Finnish at a place in Latin letters (the exchange office, Dutch customs, Amsterdam's airport and
  Posti), keep their wall clock: the tracker gives no zone for them.
- The reply is GBK, which has no Finnish ä or ö: Posti's wording arrives with a question mark in
  each such letter's place. The text is kept as received, and the status map lists it so, rather
  than guessing the letter or reading the mark as a lost space as the shared cleaning does for
  other tenants.
- The expected-flight row (预计配载航班…) is a forecast, not a movement: it keeps the stage of the
  scan before it.
- The record carries no Posti number, so no delivery carrier is named for the last leg.

## Limitations

- The copied European rows have no instant.

## Numbers

JYTWL's waybills have `JYT`, ten digits and `CN`, as TrackShip's example shows. No other carrier's
rule or sample has the layout, so the rule names JYTWL with high confidence. The series is dense,
so the rule claims the prefix shape and nothing more.

## Links

The tracker is plain HTTP only, so the catalog links no page of it, and the canary checks 17TRACK.
A pasted link to the tracker's `trackIndex.htm` is read for its number.

## Testing

Set `JYTWL_TRACKING_NUMBER` (and `JYTWL_UNKNOWN_NUMBER` for the not-found answer) outside the
repository and run `npm run test:carriers:live -- carriers/jytwl`.
