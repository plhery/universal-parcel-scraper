# Valueway Express

Valueway Express (美通快递), based in Toronto, ships parcels and online shopping between Canada and China,
with a line to Hong Kong. Its site is valueway.net. In China a domestic courier, SF Express on the public
sample, delivers the parcel under its own number. Tracked through Valueway's own tracking server, a Neoman
GInfo system on member.valueway.net, which HGD, SRJ, Yi Long Express and King Delivery also run.

## How it works

1. `direct`: one `GET https://member.valueway.net/cgi-bin/GInfo.dll?MfcISAPICommand=EmsApiTrack&cno={number}`.
   It needs no cookie, token, account or browser. The reply is a return code on its first line, then the
   waybill's summary in `EMS_INFO` and its rows in `TRACK_DATA`, in UTF-8. The reader is shared with HGD in
   [`../hgd/ginfo.ts`](../hgd/ginfo.ts).
2. `retry`: one more request when the first fails to reach the server or hangs. The first gets half of the
   budget, so the retry fits in the rest.

After a found record, one `GET` of the server's `EmmisTrack` page, the page the site's tracking form opens and
the portal link opens, reads the domestic courier and its number from the script at the page's end. The page
is GB2312 HTML. It only adds the delivery carrier, so a page that fails leaves the record as the answer.

- `-102` is the answer for a number the server holds nothing under, which is not found. Any other code but
  `100` is inconclusive, and a non-200 reply is a moved route. `TRCKING_NBR` must be the whole number asked.
- Recognition reads the record alone.

## Notes

- The page's `cNum` must be the waybill asked. `cKey` names the courier by its Kuaidi100 key and `cNo` its
  number. `KD100-shunfeng` names SF Express, which becomes the delivery carrier only when SF Express's own
  rules claim the whole number, since the key can name SF beside another courier's number. Other keys name
  none. `REFER_NBR` holds a note and is not kept.
- The rows mix clocks and state no zone. A row placed in a Canadian town is on that town's clock and one placed
  in China on China's. The domestic courier's rows, copied after customs with their city in brackets first,
  are on China's clock, and the city is their place. The forwarding warehouse's two rows are on China's clock
  too: its departure would come after the Toronto hub's on Toronto's clock. Valueway's other rows, such as a
  flight notice, are on Toronto's. Each event says how its zone was chosen, and the rows are listed by their
  instants. A row the zone would date after the lookup keeps its wall clock alone.
- The domestic rows can name the courier with their phone, who signed, and where the parcel was left. They keep
  their sentence without these, and without the notices in brackets.
- `statuses.json` writes the place or facility in a sentence as `…`. The flight delay notice moves nothing.
  `STATE` 3 is what the tracking page shows as delivered, with `ADATE` as the delivery time, and the parcel
  reads as delivered from it.
- The weight is kept. The destination is a Chinese province, not read as a country.

## Limitations

- No delivery estimate, service name, sender or recipient.
- Only SF Express's hand-off is read.

## Numbers

The public sample is VE, nine digits and CA, whose last digit is not the UPU check digit. Detection offers
Valueway as a candidate for that shape, and recognition asks its server; a number whose check digit passes
stays Canada Post's. The adapter answers explicit selection of any waybill of letters and digits. The sample
and its source are in [`numbers.json`](numbers.json).

## Testing

`npm run test:carriers:live -- carriers/valueway` tracks the public sample, or the waybill in
`VALUEWAY_TRACKING_NUMBER`, and checks an invented waybill, or the one in `VALUEWAY_UNKNOWN_NUMBER`, reads as
not found.
