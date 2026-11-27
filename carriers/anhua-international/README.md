# Anhua International

Tracks shipments of Anhua International (安华国际供应链, 广州安华国际供应链管理有限公司), a
Guangzhou forwarder whose site is www.ahgjgyl.com and whose line to Australia hands parcels to
Australia Post, on its own tenant of the Hualei (华磊) platform.

## How it works

The site's tracking form posts to Anhua's tracker at `www.ahgjgyl.com:8082`, over plain HTTP. The
adapter is the platform's ([hualei.ts](../gzyl/hualei.ts)) with this carrier's host, row cleaning
and status map:

1. `direct`: one GET to `selectTrack.htm?documentCode=<number>`, then, when the interface holds no
   row for the number, one POST of the same `documentCode` to `trackIndex.htm`, which settles
   not-found or shows an order the interface does not return.
2. `retry`: the same read once more after a request fails to reach the tracker or hangs.

Recognition asks the same lookup: a row says Anhua holds the number.

## Notes

- The record's tracking number is Australia Post's article id. Anhua's own waybill is in the
  invoice field, beside the shipper's reference; the lookup finds the record by any of them.
- The record does not name a channel. It is handed to Australia Post when Australia Post's detection
  offers its tracking number, the parcel goes to Australia and a row names Australia Post, as its
  approval of the shipment's data. Australia Post then delivers under the number the record holds.
- Every row, Anhua's in China and Hong Kong and the ones it copies from Australia Post, is on the
  platform's Beijing clock: Australia Post's own record dates the same scans three hours later, on
  eastern Australia's summer clock.
- Australia Post's delivery row names who signed after "with signature from"; the name is dropped.
- The line writes its steps in Chinese, which the status map shows in English. The batch it names
  ahead of the declaration for Hong Kong and the day of the booked flight are read as ellipses; the
  booked flight and Australia Post's approval of the data are notices that move nothing.
- The platform's custom track rows (`CO_C_CR`) are held back as written ahead, as on every Hualei
  tenant.

## Limitations

The product name is kept as the line writes it, in Chinese. No delivery estimate or weight.

## Numbers

TrackShip's Anhua International page gives two examples, both Australia Post's article ids, which
Australia Post's rules already read. No detection rule claims an Anhua layout.

## Links

The tracker is plain HTTP only, so the catalog links no page of it, and the canary checks 17TRACK.
A pasted link to the tracker's `trackIndex.htm` is read for its number.

## Testing

Set `ANHUA_INTERNATIONAL_TRACKING_NUMBER` (and `ANHUA_INTERNATIONAL_UNKNOWN_NUMBER` for the
not-found answer) outside the repository and run
`npm run test:carriers:live -- carriers/anhua-international`.
