# Yi Long Express

Yi Long Express (颐龙快递) is an international express forwarder in Shanghai, with a branch in Shenzhen,
that ships through postal networks, express integrators and its own lines. It is not Yilong
Logistics (一龙物流, Putian), which the catalog lists apart. Tracked through its own tracking server, a
Neoman GInfo system on open.ylexp.com, which HGD and SRJ also run.

## How it works

1. `direct`: one `GET http://open.ylexp.com/cgi-bin/GInfo.dll?MfcISAPICommand=EmsApiTrack&cno={number}`.
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

- `STATE` 3 is what the tracking page shows as delivered, with `ADATE` as the delivery time. The rows can
  stop well before it, as the sample's do at the sort facility, so the parcel reads as delivered from that
  state.
- Rows state no zone and keep their wall clocks. The two English wordings seen are in
  [`statuses.json`](statuses.json); others go through the shared wording rules.
- The destination is named in Chinese and read as an ISO code; the weight is kept. `REFER_NBR` held a
  free-text note on the sample and is not kept, nor is the inner number.

## Limitations

- No places, delivery estimate, service name, sender or recipient.

## Numbers

The tracker files a parcel under the number of the network that carries it: the public sample is a Correos
parcel number, which detection offers to Correos. The adapter answers explicit selection of any waybill of
letters and digits. The sample and its source are in [`numbers.json`](numbers.json).

## Testing

`npm run test:carriers:live -- carriers/ylexp` tracks the public sample, or the waybill in
`YLEXP_TRACKING_NUMBER`, and checks an invented waybill, or the one in `YLEXP_UNKNOWN_NUMBER`, reads as not
found.
