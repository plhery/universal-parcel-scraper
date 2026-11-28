# Shanghai Aerospace Logistics

Shanghai Aerospace Logistics (宇航通物流) sends parcels from China abroad, with offices in Shanghai, Shenzhen,
Guangzhou and Beijing; DHL Express carries them, and its tracker relays DHL's checkpoints in Chinese. Tracked
through its own tracking server, a Neoman GInfo system on yhtlogistics.com, which HGD, SRJ and the other GInfo
tenants also run.

## How it works

1. `direct`: one `GET http://www.yhtlogistics.com/cgi-bin/GInfo.dll?MfcISAPICommand=EmsApiTrack&cno={number}`.
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

- `TRANSKIND` DHL with DHL's waybill in `TRANS_NBR` names DHL Express as the delivery carrier. DHL's ten-digit
  waybills share their shape with other carriers' numbers, so detection alone does not name DHL; the record
  naming the service does, when DHL Express's rules take the number and no other carrier's claim it at high
  confidence.
- DHL's rows name their place as `<town> - <country>`. A row is dated on its country's clock when that
  country has one (China, Singapore), and on China's for the firm's own row at its office. A row in a
  country with several clocks, Australia for instance, or one naming a town alone, keeps its wall clock; the
  shared local-clock step (`localClocks`) dates it from its town afterwards.
- The tracker lists DHL's rows out of order, and the pieces of one shipment travel apart, so the rows are
  sorted by their clocks. Some rows repeat their place after the wording and some do not: the place is left
  out of the wording, so the two forms of one scan read once.
- `SIGN` and the delivery row name who signed; neither is kept. The destination country and the weight are
  kept; the origin, the piece count and the service name are not.

## Limitations

- No delivery estimate, sender or recipient.

## Numbers

Kuaidi100's test number is twelve bare digits, a shape many carriers' numeric waybills share, so no rule
offers Shanghai Aerospace Logistics; the adapter answers explicit selection of any waybill of letters and
digits. The sample and its source are in [`numbers.json`](numbers.json).

## Testing

`npm run test:carriers:live -- carriers/yhtlogistics` tracks Kuaidi100's test number, or the waybill in
`YHTLOGISTICS_TRACKING_NUMBER`, and checks an invented waybill, or the one in `YHTLOGISTICS_UNKNOWN_NUMBER`,
reads as not found.
