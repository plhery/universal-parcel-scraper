# SXW Express

Tracks shipments of SXW Express (深圳胜兴旺供应链管理有限公司, Shenzhen Shengxingwang Supply Chain
Management), a Shenzhen forwarder whose site is sxwexpress.cn. 17TRACK names it SXW Wuliu.

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
  number, with no channel named. A GOFO number there (`GFUS` and fourteen digits), or as the
  channel's transfer number, is GOFO's last leg in the United States, so the result names GOFO
  with it. A channel name does not change that unless it names another carrier. GOFO alone issues
  the shape, and its own tracker answers for the number, so the record's destination is not checked.
- The tracker writes the line's English rows beside the platform's Chinese ones; the status map
  reads both. The platform's Chinese rows show the English the platform's other tenants give
  them, such as "Arrived at the receiving point".
- Rows are read on Beijing's clock until the first row placed abroad: one whose place ends in
  another country's code ("…, GB", "AU"), an airport outside China named by its code alone, as
  the line's landing ("MEL"), or an Australian suburb and its state, as SXW copies Australia
  Post's rows. From that row on, rows keep their wall clock, which the places then date: the
  partner abroad gives the destination's, and so does the delivery carrier whose rows SXW copies
  after them. Read on Beijing's clock, an Australian row would come before
  the platform wrote it, and Royal Mail dates the acceptance SXW copies at that wall clock in the
  UK. The identity policy lets such a row take over the one earlier releases stored on Beijing's
  clock.
- A customs row can give "海关", Chinese for customs, as its place. It is a word, not a place, so
  the row has none, and it takes over the row earlier releases stored at that word.
- Australia Post's rows are on the clock of Australia's east coast wherever the suburb lies: SXW's
  copy of a Queensland row reads an hour later than Australia Post's own, a Victorian row the
  same. They are dated on that clock, while the line's own rows at an airport keep the airport's.
- GOFO's rows, from the first that names GOFO on, are on GOFO's clock. SXW takes GOFO's Pacific
  clocks for Eastern ones before writing them on Beijing's, so read on Beijing's clock its copies
  came three hours before GOFO's own scans. The row's clock is put back on Eastern time and read
  as Pacific, then shown on the station's zone as GOFO's adapter shows it; a row with no place
  stays on Pacific time.
- The seller can take a parcel back at the origin ("Returned parcel has been recieved by shipper")
  and send it again under the same waybill. The row reads as returned while it is the newest; once
  rows follow it, it is an exception and the rows after it lead, since an app holds a return over
  the moves that follow one.
  A row at a place with no words, only a mark such as ".", moves nothing.
- A not-found leaves the enabled universal providers to answer.

## Limitations

HTTP recognition does not ask it.

## Numbers

No public source shows a whole SXW Express number. Its waybills have `SXW` and twelve digits;
the corpus holds a made-up number in that shape. `SXW` is the company's own code, the one
17TRACK files it under, so the rule names SXW Express with high confidence.

## Links

The tracker is plain HTTP and takes numbers through its form, so no link opens one shipment.
The site answers plain HTTP only, and the canary takes HTTPS only, so it checks 17TRACK, which the
site links to beside its tracking box.

## Testing

Set `SXW_EXPRESS_TRACKING_NUMBER` (and `SXW_EXPRESS_UNKNOWN_NUMBER` for the not-found answer)
outside the repository and run `npm run test:carriers:live -- carriers/sxw-express`.
