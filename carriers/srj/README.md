# SRJ

SRJ (思睿捷, Suzhou Siruijie Supply Chain Management, whose tracking page also names Shanghai Siruijie
International Logistics) forwards express and small parcels from China, among them a line to the United
States that USPS delivers. Tracked through its own tracking server, a Neoman GInfo system on
huayu-ex.com, which HGD and Yi Long Express also run.

## How it works

1. `direct`: one `GET http://huayu-ex.com/cgi-bin/GInfo.dll?MfcISAPICommand=EmsApiTrack&cno={number}`.
   It needs no cookie, token, account or browser. The reply is a return code on its first line, then the
   waybill's summary in `EMS_INFO` and its rows in `TRACK_DATA`. The reader is shared with HGD in
   [`../hgd/ginfo.ts`](../hgd/ginfo.ts).
2. `retry`: one more request when the first fails to reach the server or hangs. The first gets half of the
   budget, so the retry fits in the rest.

- The site's tracking form posts to the same server's `EmmisTrack` page, which renders the same record as
  HTML. The server answers only plain HTTP, so the catalog links neither.
- `-102` is the answer for a number the server holds nothing under, which is not found. Any other code but
  `100` is inconclusive, and a non-200 reply is a moved route. `TRCKING_NBR` must be the whole number asked.

## Notes

- The tracker lists rows out of order; they are sorted by their clocks. Rows state no zone and keep their
  wall clocks: SRJ's own on China's clock, USPS's on the US place's. One row can give a day alone, which
  is kept as that day.
- Rows from the line SRJ forwards on end in the line's code in brackets, kept as the scan's code. USPS's
  scans come as the line's status, the place and USPS's wording: the place and the wording are kept, and
  USPS's sentence after a delivery, which repeats the clock and names the ZIP code, is not.
- `statuses.json` maps each code and wording seen. The line's `OT` covers customs and transfers alike, so
  the wording decides.
- `STATE` 3 is what the tracking page shows as delivered, with `ADATE` as the delivery time; the parcel
  reads as delivered from it.
- `REFER_NBR` holds the delivering carrier's number. It is reported as the hand-over when that carrier's
  own rules claim it whole, as USPS's do its package numbers.
- The destination is named in Chinese and read as an ISO code; the weight is kept. The inner number is not.

## Limitations

- No delivery estimate, service name, sender or recipient.

## Numbers

The public sample is LBG and eleven digits, the number of the line SRJ forwards on. One sample cannot
establish the layout, so no detection rule offers SRJ and the adapter answers explicit selection of any
waybill of letters and digits. The sample and its source are in [`numbers.json`](numbers.json).

## Testing

`npm run test:carriers:live -- carriers/srj` tracks the public sample, or the waybill in
`SRJ_TRACKING_NUMBER`, and checks an invented waybill, or the one in `SRJ_UNKNOWN_NUMBER`, reads as not found.
