# JD Express USA

JD Express USA (骏达快递) forwards parcels from the United States to China: it takes them in at its tax-free
warehouse in Milwaukie, Oregon, and its Los Angeles warehouse, flies them from Los Angeles and clears them in
China. Tracked through its own tracking server, a Neoman GInfo system on jdexpressusa.com, which HGD, SRJ and
the other GInfo tenants also run.

## How it works

1. `direct`: one `GET http://www.jdexpressusa.com/cgi-bin/GInfo.dll?MfcISAPICommand=EmsApiTrack&cno={number}`.
   It needs no cookie, token, account or browser. The reply is a return code on its first line, then the
   waybill's summary in `EMS_INFO` and its rows in `TRACK_DATA`, in GBK. The reader is shared with HGD in
   [`../hgd/ginfo.ts`](../hgd/ginfo.ts).
2. `retry`: one more request when the first fails to reach the server or hangs. The first gets half of the
   budget, so the retry fits in the rest.

- The site's tracking form posts to the same server's `EmmisTrack` page (tenant `shjunda`), which renders the
  same record as HTML. The server answers only plain HTTP, so the catalog links neither.
- `-102` is the answer for a number the server holds nothing under, which is not found. Any other code but
  `100` is inconclusive, and a non-200 reply is a moved route. `TRCKING_NBR` must be the whole number asked.

## Notes

- The rows name no place and state no zone, and their clocks pad a one-digit hour with spaces, which the
  reader pads with a zero. The wording picks each row's clock: the firm's warehouse, Los Angeles' airport and
  the flight leaving for China are on Pacific time, and from the parcel's arrival at a Chinese port, through
  customs, rows are on China's clock. The flight row is the last on Pacific time because the US side writes
  it as the parcel leaves. A row that says neither keeps its wall clock alone.
- `TRANSKIND` names China Post with the waybill itself as its number, so no delivery carrier is named.
- The origin, the destination province and town and the piece count are not kept; the weight is.

## Limitations

- No delivery estimate, service name, sender or recipient.

## Numbers

Kuaidi100's test number is in the UPU S10 layout with a valid check digit, which postal detection takes, so no
rule offers JD Express USA and the adapter answers explicit selection of any waybill of letters and digits.
The sample and its source are in [`numbers.json`](numbers.json).

## Testing

`npm run test:carriers:live -- carriers/jdexpressusa` tracks Kuaidi100's test number, or the waybill in
`JDEXPRESSUSA_TRACKING_NUMBER`, and checks an invented waybill, or the one in `JDEXPRESSUSA_UNKNOWN_NUMBER`,
reads as not found.
