# Shengtai Logistics

Beijing Shengtai Logistics (盛泰物流, stwles.com) stores goods for its clients, trucks them between
its hubs in China and delivers them from its stations. Tracked through the tracking page its site's
form posts an order number to.

## How it works

1. `direct`: one `POST http://api.stwles.com/stwl/order/orderFlowQueryByCwb` with the form field
   `cwb`, as the site's form sends it. It needs no cookie, token, account or browser. The page shows the
   order number, then a table of rows, oldest first: the time, the operator and the sentence.
2. `retry`: one more request when the first fails to reach the site or hangs. The first gets half of
   the budget, so the retry fits in the rest.

- The message 无此订单！ under the form, without a table, is the page's answer for a number it holds
  no order under. Another message is inconclusive; a page without the table and a message, an order
  other than the number asked, or a non-200 reply is a failure, never not found.

## Notes

- The host answers plain HTTP only, so the catalog gives Kuaidi100's page on Shengtai as its canary and
  links no portal.
- The page states no zone. Every row is keyed in China by Shengtai's hubs and stations, so each is read
  on China's clock. A row dated after the lookup keeps its wall clock alone.
- Each row is a sentence with the hub or station in brackets; `statuses.json` stages them with `…` for
  the station. The first bracket names the place, except on the import row, which names no hub.
- The station keys its arrival, its courier taking the parcel out, the delivery and its check of the
  delivery within seconds; the check moves nothing, so the delivery stands under it.
- The rows give hub and courier phones, the supplier and remarks, and may name the courier or the
  person who checked. Those, and the operator column, are left out; station names stay.

## Limitations

- No delivery estimate, weight, service or recipient.

## Numbers

The public samples are ten-digit order numbers, a shape many carriers' references share. No detection
rule offers Shengtai and the adapter answers explicit selection. The samples and their sources are in
[`numbers.json`](numbers.json).

## Testing

`npm run test:carriers:live -- carriers/stwles` tracks Kuaidi100's test number, or the number in
`STWLES_TRACKING_NUMBER`, and checks an invented number, or the one in `STWLES_UNKNOWN_NUMBER`, reads as
not found.
