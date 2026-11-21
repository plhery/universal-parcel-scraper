# Yusuda

Tracks shipments of Yusuda, 裕速达 (广州裕速达货运代理有限公司, Guangzhou Yusuda Freight
Forwarding), a Guangzhou forwarder selling small-parcel lines to the United States, Canada and
Europe and China Post services. Its site is ysdhy.cn.

## How it works

The site's tracking form opens `trackIndex.htm?documentCode=` on the Hualei (华磊) tracker at
`134.175.243.207:8082`, over plain HTTP. That is [GZYL's](../gzyl/README.md) tenant, so the
adapter is GZYL's with this carrier's id: the same requests, steps and not-found answer
([hualei.ts](../gzyl/hualei.ts)).

1. `direct`: one GET to `selectTrack.htm?documentCode=<number>`, then, when the interface holds no
   row for the number, one POST of the same `documentCode` to `trackIndex.htm`, which settles
   not-found.
2. `retry`: the same read once more after a request fails to reach the tracker or hangs.

## Notes

- The tracker writes GZYL's wordings, so GZYL's status map and row splitting read them, and GZYL's
  rows written ahead and scripted delivery row are held back here too, as is every row written
  with the script but the order's registration, and a universal provider's copies of them. The
  script can be in China Post's words, its Hong Kong acceptance included, all written in one
  second ahead of their clocks.
- A not-found leaves the enabled universal providers to answer.

## Limitations

HTTP recognition does not ask it.

## Numbers

No public source shows a whole Yusuda number. A parcel a universal provider files under YUSUDA
has `SYD`, ten digits and `YQ`, the layout of forwarders on the Hualei platform, which open their
waybills with their own code. Yusuda's tracker holds such parcels under the whole number and names
their service "SYD全球通" (SYD Global). The rule names Yusuda with high confidence; the corpus holds
a made-up number in that shape.

## Links

No portal link is published, since a plain-HTTP link would leave the number in the clear. The
canary takes HTTPS only, so it checks 17TRACK, not the tracker.

## Testing

Set `YUSUDA_TRACKING_NUMBER` (and `YUSUDA_UNKNOWN_NUMBER` for the not-found answer) outside the
repository and run `npm run test:carriers:live -- carriers/yusuda`.
