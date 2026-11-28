# Ronghui Supply Chain

Ronghui Supply Chain (融辉供应链, Guangdong Ronghui Supply Chain Management) carries less-than-truckload
freight and express from Shenzhen and Guangzhou to China's inland provinces. Tracked through its own
tracking server, a Neoman GInfo system on roh56.com, which HGD, SRJ and the other GInfo tenants also run.

## How it works

1. `direct`: one `GET http://www.roh56.com/cgi-bin/GInfo.dll?MfcISAPICommand=EmsApiTrack&cno={number}`.
   It needs no cookie, token, account or browser. The reply is a return code on its first line, then the
   waybill's summary in `EMS_INFO` and its rows in `TRACK_DATA`, in GBK. The reader is shared with HGD in
   [`../hgd/ginfo.ts`](../hgd/ginfo.ts).
2. `retry`: one more request when the first fails to reach the server or hangs. The first gets half of the
   budget, so the retry fits in the rest.

- The site's tracking form posts to the same server's `EmmisTrack` page, which renders the same record as
  HTML. The server answers only plain HTTP, so the catalog links neither.
- `-102` is the answer for a number the server holds nothing under, which is not found. Any other code but
  `100` is inconclusive, and a non-200 reply is a moved route. `TRCKING_NBR` must be the whole number asked.

## Notes

- Every row is written in China by Ronghui's network and states no zone, so each is dated on China's clock,
  with `carrier` as the basis.
- The network's hub scans name the clerk who scanned, the courier and who signed, in brackets after the
  sentence. Those are left out, with anything after a phone.
- `STATE` 3 is what the tracking page shows as delivered (送达！), with `ADATE` as the delivery time, and the
  parcel reads as delivered from it.
- `statuses.json` writes the facility in a sentence as `…`.
- The origin, the destination town and the piece count are not kept: the destination names a province and
  town, not a country.

## Limitations

- No delivery estimate, weight, service name, sender or recipient.

## Numbers

The public samples are eight bare digits, a shape many carriers print, so no detection rule offers Ronghui
and the adapter answers explicit selection of any waybill of letters and digits. The samples and their
sources are in [`numbers.json`](numbers.json).

## Testing

`npm run test:carriers:live -- carriers/roh56` tracks Kuaidi100's test number, or the waybill in
`ROH56_TRACKING_NUMBER`, and checks an invented waybill, or the one in `ROH56_UNKNOWN_NUMBER`, reads as not
found.
