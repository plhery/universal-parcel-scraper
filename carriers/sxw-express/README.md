# SXW Express

Tracks shipments of SXW Express (Shenzhen Shengxingwang Supply Chain Management), a Shenzhen
forwarder whose site is sxwexpress.cn. 17TRACK names it SXW Wuliu.

## How it works

The site's tracking page is SXW's own tenant of the Hualei (华磊) platform at
`www.sxwexpress.cn:8082`, over plain HTTP. The adapter is the platform's
([hualei.ts](../gzyl/hualei.ts)) with this carrier's host and status map:

1. `direct`: one GET to `selectTrack.htm?documentCode=<number>`, then, when the interface holds no
   row for the number, one POST of the same `documentCode` to `trackIndex.htm`, which settles
   not-found.
2. `retry`: the same read once more after a request fails to reach the tracker or hangs.

## Notes

- A record keeps SXW's own number in its invoice field and the delivery carrier's in its tracking
  number, with no channel named. A GOFO number there is GOFO's last leg in the United States, so
  the result names GOFO with it.
- The tracker writes the line's English rows beside the platform's Chinese ones; the status map
  reads both.
- A not-found leaves the enabled universal providers to answer.

## Limitations

HTTP recognition does not ask it.

## Numbers

No public source shows a whole SXW Express number. Its waybills have `SXW` and twelve digits;
the corpus holds a made-up number in that shape. `SXW` is the company's own code, the one
17TRACK files it under, so the rule names SXW Express with high confidence.

## Links

The tracker is plain HTTP and takes numbers through its form, so no link opens one shipment.

## Testing

Set `SXW_EXPRESS_TRACKING_NUMBER` (and `SXW_EXPRESS_UNKNOWN_NUMBER` for the not-found answer)
outside the repository and run `npm run test:carriers:live -- carriers/sxw-express`.
