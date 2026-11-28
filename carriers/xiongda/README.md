# Xiong Da International Logistics

Xiong Da (上海雄达国际物流有限公司), based in Shanghai with branches in Shenzhen and other Chinese cities, flies and
ships Amazon FBA cartons from China to the United States, where UPS delivers them. Tracked through the interface
the tracking page of its site, xdint.com, asks.

## How it works

1. `direct`: one `GET https://www.xdint.com/ajax/jiekou.aspx?status=chaxunnew&no={number}`, the request the page
   `/no/EmmisTrack.aspx?no={number}` makes. It needs no cookie, token, account or browser. The reply is JSON served
   as `text/html`: one order with the waybill in `orderNo`, the customer's reference in `referenceNo`, and its rows,
   newest first. One of the two must be the whole number asked.
2. `retry`: one more request when the first fails to reach the site or hangs. The first gets half of the budget,
   so the retry fits in the rest.

- An order without rows whose `orderNo` is the number asked is not found: the tracker holds nothing under it, or
  no longer does. Without rows under another number, with `success` false or another `code`, the answer is
  inconclusive.

## Notes

- A row is written as the page shows it, its label (`activity`) then its note (`remark`), with its event code.
- Most codes have one stage. Code 9060 is an update in words of its own: the firm's notes from the United States,
  and the scans it copies from UPS once UPS has the cartons, each behind a label such as 正在派送 that every copied
  scan carries. Such a row's stage comes from its words, and reads at least as in transit.
- The rows state no zone. A row's `country` and `city` give its place. A row in China is on China's clock, and a
  row in another country of one clock on that country's. A US row is on its state's clock when its city names a
  state of one clock; otherwise, and for a row without a country, as UPS's copied scans are, it keeps its wall
  clock alone. The city 市辖区, or its pinyin, names no place and is left out.
- A note that names who signed or a phone is cut before it.
- The reply names the delivering carrier's number only for some orders. UPS and its number become the delivery
  carrier and number when the reply names UPS and one valid `1Z` number.
- The waybill's `destinationCountry` gives the destination. Its flight, air waybill and the progress rail's
  milestones are left out.

## Limitations

- No delivery estimate, weight, service name, sender or recipient.

## Numbers

Kuaidi100's example number is XD, the booking's date as six digits and a four-digit counter, a shape other carriers'
rules also take, so detection does not offer Xiong Da for it. Its test number's order is gone from the tracker, so
it is kept as quarantined evidence. The samples and their sources are in [`numbers.json`](numbers.json).

## Testing

`npm run test:carriers:live -- carriers/xiongda` tracks Kuaidi100's example number, or the number in
`XIONGDA_TRACKING_NUMBER`, and checks an invented number, or the one in `XIONGDA_UNKNOWN_NUMBER`, reads as not
found.
