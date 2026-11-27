# HUBO Logistics

HUBO Logistics (巨宝物流, 广东巨宝国际物流有限公司), based in Guangzhou, ships sellers' goods by sea and air from
China to Amazon warehouses in North America, Europe and Australia. Its site is hubologistics.com. Tracked through
the service its enquiry page asks.

## How it works

1. `direct`: one `GET https://gwapi.hubologistics.com/gw/order/customer/orderInfo/{order}`, as the enquiry page
   asks. It needs no cookie, token, account or browser, and reads the order number in either case. The reply is
   JSON: `code` 200 and the order in `data`, with its channel, totals, destination warehouse and `routeList`, its
   rows newest first.
2. `retry`: one more request when the first fails to reach the service or hangs. The first gets half of the
   budget, so the retry fits in the rest. The server is sometimes slow to accept a connection from abroad, so the
   default budget is 20 seconds.

- `code` 200 with no `data` is the service's answer for an order it does not hold, which is not found. Another
  `code` is inconclusive; HTML is a browser check or a changed route, and a non-200 reply is a moved route or a
  request the service refuses.
- The order and every row must carry the number asked as `orderCode`; a reply for another order is refused whole.
- The `route/list` service beside it needs a login, so the adapter does not use it.

## Notes

- `routingTime` is a wall clock with no zone. HUBO's staff and system write a row at the time they enter it, on
  China's clock, wherever the place it names: a row placed at the port of Long Beach was dated seconds before the
  record's own creation stamp, which the server writes on China's clock. So those rows are dated on China's clock
  with `carrier` as the basis. A row copied in English from the delivery partner abroad (`routingEnContent`) keeps
  that partner's clock: its country's zone when the country keeps one, else its wall clock alone. A clock that
  would date a row after the lookup keeps its wall clock alone.
- Newer rows carry a node code, kept as the scan's code, and a country and city, kept as the location. Older rows
  and some newer ones are free text by HUBO's staff, often with dates and the vessel; `statuses.json` lists the
  codes and, in order, the phrases a text is read by. Delays, booked appointments and new arrival dates are
  notices that keep the stage before them.
- The destination is an Amazon warehouse. The result keeps its country and, in the United States, its town and
  state as `receiver_address`; the street and ZIP code are left out. `customerChannelName` is the service and
  `totalWeight` the weight in kilograms.
- `createBy` and `updateBy` (the staff who wrote each row), `annexUrl` (pictures of the receipt), the shipper's
  Amazon shipment id and the vessel's arrival estimate (`eta`, not a delivery date) are never read. Mobile numbers
  are taken out of a row's text.
- The enquiry page renders nothing for an order the service does not hold, so no case checks the catalog's link.

## Limitations

- No delivery estimate, sender or recipient. Outside the United States the destination's town is not read.

## Numbers

Orders are two letters, the year and month, and a sequence: OZ and ten digits, ZD and twelve on the samples. These
are HUBO's own references in shapes other firms print, so detection does not name HUBO, and the adapter answers
explicit selection for any number of 6 to 40 letters and digits. The samples and their sources are in
[`numbers.json`](numbers.json).

## Testing

`npm run test:carriers:live -- carriers/hubologistics` tracks the public sample, or the number in
`HUBOLOGISTICS_TRACKING_NUMBER`, and checks an invented order, or the one in `HUBOLOGISTICS_UNKNOWN_NUMBER`, reads
as not found.
