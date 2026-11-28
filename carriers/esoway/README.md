# ESOWAY

ESOWAY (易速递, 加拿大易速递) flies parcels from its Burnaby and Richmond offices near Vancouver to China,
clears them there and hands them to ZTO for delivery. Tracked through its own tracking server, a Neoman
GInfo system on esoway.com, which HGD, SRJ and the other GInfo tenants also run.

## How it works

1. `direct`: one `GET http://www.esoway.com/cgi-bin/GInfo.dll?MfcISAPICommand=EmsApiTrack&cno={number}`.
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

- The rows state no zone. ESOWAY's Vancouver office writes its rows until the flight leaves, so a row that
  names Vancouver, or the flight leaving for China, is dated on Pacific time. Its rows from the arrival in
  China and through customs, the waybill row and ZTO's rows, which name a ZTO site, are dated on China's
  clock. A row that says neither keeps its wall clock alone. The rows are listed by their instants: the
  record writes the waybill row first.
- Once ZTO has the parcel, ESOWAY copies ZTO's sentences. They name the city in brackets, the courier with a
  mobile, the branch's and complaint lines, the pickup locker and who signed, and end on a courtesy. The
  shared [`../zto/relayed.ts`](../zto/relayed.ts) keeps the sentence and takes the city as the place;
  a locker's name, which can give the recipient's building, is not kept as the place either.
- A row whose place reads 中通转单号 gives ZTO's waybill, which `REFER_NBR` repeats. ZTO and that waybill
  become the delivery carrier and number when ZTO's rules take it and `REFER_NBR` gives no other. ZTO's
  waybills are 14 digits, a shape other carriers share, so the shared reader's own check would not name ZTO.
- `STATE` 3 is what the tracking page shows as delivered (送达！), with `ADATE` as the delivery time, and the
  parcel reads as delivered from it.
- `statuses.json` writes the branch or centre in a sentence as `…`.
- The origin, the destination province, the piece count and `SIGN`, the delivery spot, are not kept.

## Limitations

- No delivery estimate, service name, sender or recipient.

## Numbers

Kuaidi100's test number is ES, ten digits and CA, a shape no other carrier's rule takes, so a low rule
offers ESOWAY for it and recognition asks the tracker. Its example number is DD and eight digits, a shape
GLS Italy's and TNT Italy's rules also suggest, so nothing offers ESOWAY for it. The samples and their
sources are in [`numbers.json`](numbers.json).

## Testing

`npm run test:carriers:live -- carriers/esoway` tracks Kuaidi100's test number, or the waybill in
`ESOWAY_TRACKING_NUMBER`, and checks an invented waybill, or the one in `ESOWAY_UNKNOWN_NUMBER`, reads as not
found.
