# Xinhongda Logistics

Xinhongda Logistics (新宏达物流, Yueqing Xinhongda Logistics) trucks less-than-truckload freight and
parcels from Yueqing and Wenzhou to its stations across China. Tracked through its own tracking server, a
Neoman GInfo system on xhongda56.com, which HGD, Ronghui and the other GInfo tenants also run.

## How it works

1. `direct`: one `GET http://www.xhongda56.com/cgi-bin/GInfo.dll?MfcISAPICommand=EmsApiTrack&cno={number}`.
   It needs no cookie, token, account or browser. The reply is a return code on its first line, then the
   waybill's summary in `EMS_INFO` and its rows in `TRACK_DATA`, in GBK. The reader is shared with HGD in
   [`../hgd/ginfo.ts`](../hgd/ginfo.ts).
2. `retry`: one more request when the first fails to reach the server or hangs. The first gets half of the
   budget, so the retry fits in the rest.

- The site's tracking form posts to the same server's `EmmisTrack` page, which renders the same record as
  HTML. The server answers only plain HTTP, so the catalog links neither and gives Kuaidi100's page on
  Xinhongda as its canary.
- `-102` is the answer for a number the server holds nothing under, which is not found. Any other code but
  `100` is inconclusive, and a non-200 reply is a moved route. `TRCKING_NBR` must be the whole number asked.

## Notes

- Every row is written in China by Xinhongda's network and states no zone, so each is dated on China's
  clock, with `carrier` as the basis.
- Two kinds of sentence appear. The older ones name the next hub as written, and `PLACE` is where the row
  was written. The newer ones name stations in 【】, and `PLACE` holds the next stop or the destination
  station, so their place is the first station the sentence names.
- The rows name the collector and who signed. Those are left out, with anything after a phone, and the
  record's `SIGN` is never read.
- `statuses.json` writes the station or hub in a sentence as `…`.
- The origin, the destination town and the piece count are not kept: the destination names a town, not a
  country.

## Limitations

- No delivery estimate, service name, sender or recipient.

## Numbers

The public samples are seven bare digits, a shape other carriers print, so no detection rule offers
Xinhongda and the adapter answers explicit selection of any waybill of letters and digits. The samples and
their sources are in [`numbers.json`](numbers.json).

## Testing

`npm run test:carriers:live -- carriers/xhongda56` tracks Kuaidi100's test number, or the waybill in
`XHONGDA56_TRACKING_NUMBER`, and checks an invented waybill, or the one in `XHONGDA56_UNKNOWN_NUMBER`,
reads as not found.
