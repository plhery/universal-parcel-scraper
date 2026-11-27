# King Delivery

King Delivery (快达物流, Beijing KuaiDa International Logistics) is a Beijing forwarder and
fulfilment house: express and dedicated lines abroad, and domestic parcels that JD Logistics carries
under King Delivery's waybill. Tracked through its own tracking server, a Neoman GInfo system on
kuaidaexp.com, which HGD, SRJ and Yi Long Express also run.

## How it works

1. `direct`: one `GET https://www.kuaidaexp.com/cgi-bin/GInfo.dll?MfcISAPICommand=EmsApiTrack&cno={number}`.
   It needs no cookie, token, account or browser. The reply is a return code on its first line, then the
   waybill's summary in `EMS_INFO` and its rows in `TRACK_DATA`, in UTF-8. The reader is shared with HGD
   in [`../hgd/ginfo.ts`](../hgd/ginfo.ts).
2. `retry`: one more request when the first fails to reach the server or hangs. The first gets half of the
   budget, so the retry fits in the rest.

- The site's tracking form opens the same server's `emmistrack` page, which renders the same record as
  GBK HTML; the portal link opens it.
- `-102` is the answer for a number the server holds nothing under, which is not found. Any other code but
  `100` is inconclusive, and a non-200 reply is a moved route. `TRCKING_NBR` must be the whole number asked.

## Notes

- A domestic parcel's rows are JD's sentences under King Delivery's name. `TRANSKIND` names JD's express
  service and `TRANS_NBR` JD's waybill, which is reported as the delivery carrier's number when JD's own
  rules claim it whole. `REFER_NBR` holds an order reference and is not kept.
- The rows name the couriers and their phones and add care notices after the first sentence. A row keeps
  its first sentence, without the courier's name and phone or a signatory.
- `PLACE` names the facility, except on a put-off collection, where it repeats the reason the wording gives
  in brackets; that reason is not read as a place.
- The rows come out of order and start with a blank one; they are sorted by their wall clocks, which state no
  zone and are China's.
- `statuses.json` writes the facility in a sentence as `…`. The courier's call to the recipient moves
  nothing. `STATE` 3 is what the tracking page shows as delivered, with `ADATE` as the delivery time, and
  the parcel reads as delivered from it.
- The weight is kept. The destination is a Chinese town, not read as a country.

## Limitations

- No delivery estimate, service name, sender or recipient.
- Only JD's hand-off is read; other services in `TRANSKIND` name no delivery carrier.

## Numbers

The public sample is KDZGZ and nine digits. No other carrier's rule or sample takes that shape, so
detection offers King Delivery for it; the adapter answers explicit selection of any waybill of letters and
digits. The sample and its source are in [`numbers.json`](numbers.json).

## Testing

`npm run test:carriers:live -- carriers/king-delivery` tracks the public sample, or the waybill in
`KING_DELIVERY_TRACKING_NUMBER`, and checks an invented waybill, or the one in
`KING_DELIVERY_UNKNOWN_NUMBER`, reads as not found.
