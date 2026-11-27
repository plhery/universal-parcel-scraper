# Qinhang Transportation

Qinhang Transportation ships goods by sea from Shenzhen to the United States, where a US trucking firm,
ArcBest on the public sample, delivers them. Its site is qinhang56.com. Tracked through Qinhang's own tracking
server, a Neoman GInfo system, which HGD, SRJ, Yi Long Express, King Delivery and Valueway Express also run.

## How it works

1. `direct`: one `GET http://www.qinhang56.com/cgi-bin/GInfo.dll?MfcISAPICommand=EmsApiTrack&cno={number}`.
   It needs no cookie, token, account or browser. The reply is a return code on its first line, then the
   waybill's summary in `EMS_INFO` and its rows in `TRACK_DATA`, in GBK. The reader is shared with HGD in
   [`../hgd/ginfo.ts`](../hgd/ginfo.ts).
2. `retry`: one more request when the first fails to reach the server or hangs. The first gets half of the
   budget, so the retry fits in the rest.

- The site's tracking form posts to the same server's `EmmisTrackE` page, which renders the same record as
  HTML. The server answers only plain HTTP, so the catalog links neither.
- `-102` is the answer for a number the server holds nothing under, which is not found. Any other code but
  `100` is inconclusive, and a non-200 reply is a moved route. `TRCKING_NBR` must be the whole number asked.

## Notes

- Qinhang's office writes every row, with Shenzhen as its place or none, also once the container is in the
  United States. The rows state no zone, so each is dated on China's clock, the office's, with `carrier` as the
  basis. A row whose place is a US town in a state of one clock would be dated on that state's clock instead,
  and a town in a state of several keeps its wall clock alone. A row at 00:00:00 is read as that clock, as the
  shared reader reads any row with a time.
- After the first two rows, the rows are the office's notes on the container, naming its dates, vessel and port.
  `statuses.json` writes the varying parts as `…`.
- The note that names the US trucking firm gives its number and tracking site, then the firm's phone. The phone
  and anything after it are left out. When the note names ArcBest's tracking site, arcb.com, with a nine-digit
  number, ABF Freight becomes the delivery carrier with that PRO number.
- The destination is named in Chinese and read as an ISO code; the weight is kept. The origin and the piece
  count are not.

## Limitations

- No delivery estimate, service name, sender or recipient.
- Only ArcBest's hand-off is read.

## Numbers

The public sample is QH and eight digits, which reads as the day of the forecast and a sequence. GLS Italy's
and TNT Italy's rules suggest the same shape, so no detection rule offers Qinhang and the adapter answers
explicit selection of any waybill of letters and digits. The sample and its source are in
[`numbers.json`](numbers.json).

## Testing

`npm run test:carriers:live -- carriers/qinhang-transportation` tracks the public sample, or the waybill in
`QINHANG_TRANSPORTATION_TRACKING_NUMBER`, and checks an invented waybill, or the one in
`QINHANG_TRANSPORTATION_UNKNOWN_NUMBER`, reads as not found.
