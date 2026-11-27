# LingXun Logistics

Tracks shipments of LingXun (深圳市领讯物流有限公司, 领讯物流), a Shenzhen forwarder whose site is
lingxun.top, on its lines abroad such as the one to Australia.

## How it works

The site's tracking page sends visitors to LingXun's own tenant of the Hualei (华磊) platform at
`129.204.198.136:8082`, over plain HTTP. The adapter is the platform's
([hualei.ts](../gzyl/hualei.ts)) with this carrier's host, clocks and status map:

1. `direct`: one GET to `selectTrack.htm?documentCode=<number>`, then, when the interface holds no
   row for the number or answers with a record that only echoes it, one POST of the same
   `documentCode` to `trackIndex.htm`, which settles not-found.
2. `retry`: the same read once more after a request fails to reach the tracker or hangs.

Recognition asks the same lookup: a row says LingXun holds the number.

## Notes

- The line's own rows are on the platform's Beijing clock: a row with a kind code, without a
  place, placed in Chinese or at `CN`, or worded in Chinese. The rows the line copies from the
  delivery network abroad, placed at a town named in English, keep that town's wall clock, which
  the tracker gives without its zone.
- On the line to Australia the copies are worded as DAI Post's scans, and the transfer field holds
  a number in DAI Post's SSCC range. No channel names a carrier and no rule claims that number with
  high confidence, so the result names no delivery carrier.
- The platform's custom track rows (`CO_C_CR`), written in one go days ahead of their clocks, are
  held back as written ahead, as on every Hualei tenant.

## Limitations

- Rows abroad have no instant: the tracker gives their wall clock without its zone.

## Numbers

LingXun's numbers have `LX` and twelve digits, as TrackShip's example shows. The rule is low and
recognition asks the tracker.

## Links

The tracker is plain HTTP only, so the catalog's search page is the site's HTTPS tracking page,
which redirects to it; the canary checks that page too.

## Testing

Set `LINGXUN_LOGISTICS_TRACKING_NUMBER` (and `LINGXUN_LOGISTICS_UNKNOWN_NUMBER` for the not-found
answer) outside the repository and run `npm run test:carriers:live -- carriers/lingxun-logistics`.
