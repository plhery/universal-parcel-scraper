# HongShu Express

HongShu Express (红树国际快递) is a Chinese-community courier with a store in Mississauga, Ontario, that
flies parcels between Canada and China; SF Express delivers them in China. Tracked through the tracking
form on its own site.

## How it works

1. `direct`: one `POST http://hexpress.ca/Track` with the form field `transactionid={number}`. It needs no
   cookie, token, account or browser. The reply is the HTML page the site shows: a bar naming the waybill,
   the recipient and the domestic courier, then a table of rows, oldest first.
2. `retry`: one more request when the first fails to reach the site or hangs. The first gets half of the
   budget, so the retry fits in the rest.

- The site serves no HTTPS, so the lookup goes over plain HTTP and the catalog has no tracking link or
  search page for it; the weekly canary probes 17TRACK instead.
- 货单不存在 is the site's answer for a number it holds nothing under, which is not found. A page without
  the result heading is a changed route or a browser check. The bar must name the whole number asked.

## Notes

- After customs the page copies SF Express's rows, each with its city in square brackets first. Those rows
  name the courier and their phone, where the parcel was left, and notes; a row keeps its sentence without
  them, through the reader Huaxia Express uses for the same copied rows.
- Each row is dated on its own clock, neither written with a zone: SF's rows and the 【中国】 milestones on
  China's, the 【加拿大】 milestones and the store's own rows on Toronto's. The milestones are entered by hand,
  most at midnight; a milestone at midnight keeps its day alone.
- The bar names the domestic courier, and SF Express is reported as the delivery carrier when it does. Its
  number is shown only to whoever gives the recipient's phone, so it is not read. The recipient is never
  read.
- `statuses.json` writes the facility in a sentence as `…`. The delivery station's courier assignment moves
  nothing.

## Limitations

- No delivery estimate, weight, service name, sender or destination.
- Only one sample has been seen, a parcel from Canada to China; the shape of a China-to-Canada parcel's rows
  is not known.

## Numbers

The public sample is H and seven digits, the only shape the adapter accepts. GLS's and other carriers'
rules take the same shape, so detection does not offer HongShu for it. The sample and its source are in
[`numbers.json`](numbers.json).

## Testing

`npm run test:carriers:live -- carriers/hongshu-express` tracks the public sample, or the waybill in
`HONGSHU_EXPRESS_TRACKING_NUMBER`, and checks an invented waybill, or the one in
`HONGSHU_EXPRESS_UNKNOWN_NUMBER`, reads as not found.
