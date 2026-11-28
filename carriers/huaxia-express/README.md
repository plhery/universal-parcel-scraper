# Huaxia Express

Huaxia Express (华夏快递, Huaxia International Express) is a Chinese-community courier in Richmond,
British Columbia, that flies parcels from Canada to China, where SF Express delivers them. Tracked
through its own tracking server, a Neoman GInfo system on huaxiaglobal.ca.

## How it works

1. `direct`: one `GET https://www.huaxiaglobal.ca/cgi-bin/GInfo.dll?MfcISAPICommand=EmsApiTrack&cno={number}`.
   It needs no cookie, token, account or browser. The reply is a return code on its first line, then the
   waybill's summary in `EMS_INFO` and its rows in `TRACK_DATA`, in UTF-8. The reader is shared with HGD
   in [`../hgd/ginfo.ts`](../hgd/ginfo.ts).
2. `retry`: one more request when the first fails to reach the server or hangs. The first gets half of the
   budget, so the retry fits in the rest.

- The site's tracking page opens the same server's `EmmisTrack` page, which renders the same record as
  GB2312 HTML; the portal link opens it.
- `-102` is the answer for a number the server holds nothing under, which is not found. Any other code but
  `100` is inconclusive, and a non-200 reply is a moved route. `TRCKING_NBR` must be the whole number asked.

## Notes

- After customs the tracker copies SF Express's rows, with the city in `PLACE`. `TRANSKIND` then names
  SF's interface (丰桥接口) and `TRANS_NBR` SF's waybill, reported as the delivery carrier's number when
  SF's own rules claim it whole.
- SF's rows name the courier and their phone, where the parcel was left, and notes after the first
  sentence. A row keeps its sentence without them, through Valueway's reader of the same copied rows; a
  station cut short at its address keeps its closing bracket.
- The rows mix two clocks, neither with a zone. A row placed in Richmond, the airport and the flight leaving
  Vancouver are on Vancouver's clock; a row placed in a Chinese city and the Chinese port's customs on
  China's. Each row is dated on its own clock and the rows are listed by their instants.
- `statuses.json` writes the varying place in a sentence as `…`. A traffic delay notice and the delivery
  station's courier assignment move nothing. `STATE` 3 is what the tracking page shows as delivered, with
  `ADATE` as the delivery time, and the parcel reads as delivered from it.
- The weight and the destination country are kept.

## Limitations

- No delivery estimate, service name, sender or recipient.
- Only SF's hand-off is read; another service in `TRANSKIND` names a delivery carrier only through
  `REFER_NBR`.

## Numbers

The public sample is HE and ten digits, the only shape the adapter accepts. Colis Privé's and Aramex's
rules take the same shape, so detection does not offer Huaxia for it. The sample and its source are in
[`numbers.json`](numbers.json).

## Testing

`npm run test:carriers:live -- carriers/huaxia-express` tracks the public sample, or the waybill in
`HUAXIA_EXPRESS_TRACKING_NUMBER`, and checks an invented waybill, or the one in
`HUAXIA_EXPRESS_UNKNOWN_NUMBER`, reads as not found.
