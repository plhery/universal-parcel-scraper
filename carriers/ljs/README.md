# LJS International Freight

Tracks shipments of LJS (深圳利佳顺国际货运代理有限公司, 利佳顺国际货运), a Shenzhen forwarder whose site
is bt-exp.com, on its lines abroad such as the one to Japan.

## How it works

The site's tracking form posts to LJS's own tenant of the Hualei (华磊) platform at
`115.29.184.71:8082`, over plain HTTP. The adapter is the platform's
([hualei.ts](../gzyl/hualei.ts)) with this carrier's host, clocks, hand-off and status map:

1. `direct`: one GET to `selectTrack.htm?documentCode=<number>`, then, when the interface holds no
   row for the number, one POST of the same `documentCode` to `trackIndex.htm`, which settles
   not-found.
2. `retry`: the same read once more after a request fails to reach the tracker or hangs.

Recognition asks the same lookup: a row says LJS holds the number.

## Notes

- On the line to Japan the record's tracking number is Sagawa's, and the line copies Sagawa's
  steps from Sagawa's page, each after an arrow and placed at a Sagawa office or hub. Those copies
  name Sagawa as the delivery carrier with that number, unless a channel names another carrier.
  Sagawa's summary row, its piece count with two offices' telephone numbers as the place, is
  dropped.
- Sagawa's steps are read on Japan's clock: the delivery row reads a time after the moment the
  platform wrote it, on Beijing's clock, and before it on Japan's. The line's own rows, in China
  and up to the flight's landing in Japan, are on the platform's Beijing clock.
- The interface gives the arrow before Sagawa's newest step as a question mark, which GBK cannot
  hold; the adapter drops it with the other arrows.
- The flight booked for the parcel (`预配<date>航班`) is a notice: it keeps the stage before it,
  and is shown in English with its date.
- For an unknown number the tracking page shows its bare search form, with no waybill and the
  number not echoed, instead of the waybill that only echoes the number other tenants show. After
  the interface's no-row answer for the number, that page is not-found (`bareUnknownPage`).

## Numbers

LJS's waybills are ten bare digits, a shape many carriers share, so detection leaves them to the
tracker. The tracker also finds a record by Sagawa's number.

## Links

The site and the tracker are plain HTTP only, so the catalog links no page of them. The canary
takes HTTPS only, so it checks 17TRACK.

## Testing

Set `LJS_TRACKING_NUMBER` (and `LJS_UNKNOWN_NUMBER` for the not-found answer) outside the
repository and run `npm run test:carriers:live -- carriers/ljs`.
