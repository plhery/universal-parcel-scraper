# Qilin International

Tracks shipments of Qilin International (广州市琪林国际物流有限公司, 琪林国际), a Guangzhou
forwarder, on its lines to Europe.

## How it works

Qilin's own tenant of the Hualei (华磊) platform answers at `www.qlgj168.com:8082`, over plain
HTTP, the tracker its site links. The adapter is the platform's ([hualei.ts](../gzyl/hualei.ts))
with this carrier's host, clocks and status map:

1. `direct`: one GET to `selectTrack.htm?documentCode=<number>`, then, when the interface holds no
   row for the number, one POST of the same `documentCode` to `trackIndex.htm`, which settles
   not-found.
2. `retry`: the same read once more after a request fails to reach the tracker or hangs.

Recognition asks the same lookup: a row says Qilin holds the number.

## Notes

- Rows in China, placed in Chinese, in Latin letters ("shen zhen", "shanghai") or nowhere, are
  read on Beijing's clock. A row placed abroad, such as the flight's arrival at its airport, keeps
  its wall clock: the tracker states no zone for it.
- The rows it copies from DHL, most without a place, are on DHL's clock where DHL scanned the
  parcel: a town's when one is named, Germany's for those before the parcel leaves for the
  destination country, else the destination's. Read on Beijing's clock, they would come seven
  hours before DHL's own rows for the same scans.
- A record names the delivery carrier's number as its tracking number, beside Qilin's own: DHL's on
  the line to Europe. It is named only when DHL's rule claims the number whole.
- Some rows are worded only in Chinese; the adapter shows them in English.
- Its notes on the booked flight name the day, as "Estimated departure is" and a month and ordinal,
  and its landing names the airport: the map reads the day and the airport as an ellipsis.

## Numbers

Qilin's numbers have `QL`, thirteen digits and `YQ`. No public sample is known; the sample is made
up in the shape of parcels the app tracked.

## Links

The tracker is plain HTTP only, so the catalog links no page of it. The canary takes HTTPS only,
so it checks 17TRACK.

## Testing

Set `QLGJ_TRACKING_NUMBER` (and `QLGJ_UNKNOWN_NUMBER` for the not-found answer) outside the
repository and run `npm run test:carriers:live -- carriers/qlgj`.
