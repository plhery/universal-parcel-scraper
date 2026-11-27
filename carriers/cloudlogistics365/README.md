# Qunhang International Logistics

Qunhang International Logistics (群航国际物流, 天津群航国际货运代理有限公司), a freight forwarder in Tianjin,
clears cross-border e-commerce parcels into China through Tianjin on its YunLogix platform (云物流), and YTO
Express delivers them under the same waybill. Its site is cloudlogistics365.com. Tracked through the fragment
the platform's tracking box loads.

## How it works

1. `direct`: one `GET http://z.cloudlogistics365.com/_include/import/shipment/_track.jsp?oids={number}`. It needs
   no cookie, token or account. The host's certificate is its own, so the fragment is asked over plain HTTP, as
   the platform's pages do. The reply is an HTML fragment: one accordion group per shipment, headed by its
   origin country and its number, with its rows oldest first.
2. `retry`: one more request when the first fails to reach the platform or hangs. The first gets half of the
   budget, so the retry fits in the rest.

- The fragment with an empty accordion is the platform's answer for a number it holds nothing under, which is
  not found. Only the group whose heading is the whole number asked is read; a fragment without it, or with
  anything else in the accordion, is refused. A group without rows is a number without a history yet. A reply
  that is not the fragment is a browser check or a changed route, and a non-200 reply is a moved route.
- The catalog gives no tracking link: the fragment is plain HTTP and the platform's pages load it in a pop-up.

## Notes

- Clocks have no zone. Qunhang's own rows (transport, customs, clearance) are to the minute and YTO's rows after
  them to the second; all are in China and dated on China's clock, with `carrier` as the basis.
- The rows are read newest first.
- Qunhang's rows go on to name the operator's contact and the customs line, and YTO's name couriers, mobiles,
  hotlines and the pickup point's address and phone. Those, and the courtesy after them, are taken out.
- The clearance row ends on the airport that cleared the parcel, as 中国天津滨海国际机场/TSN(CN), which becomes
  the location without the country's name in front. A YTO row's first bracketed place is the location.
- The heading's country is the origin, and China the destination.
- The waybill is YTO's: when YTO's rules take the number, YTO is the delivery carrier with that number.
- `statuses.json` records each text with its places as 【…】 and the pickup point's name as (…).

## Limitations

- No delivery estimate, weight, service name, sender or recipient.

## Numbers

Qunhang ships under YTO's waybill, YT and thirteen digits, which YTO's rule owns, so detection names YTO for it
and never Qunhang (a collision in `core/detection/gaps.json`). The adapter answers explicit selection of any
number of 6 to 30 letters and digits. The sample and its source are in [`numbers.json`](numbers.json).

## Testing

`npm run test:carriers:live -- carriers/cloudlogistics365` tracks the public sample, or the number in
`CLOUDLOGISTICS365_TRACKING_NUMBER`, and checks an invented waybill, or the one in
`CLOUDLOGISTICS365_UNKNOWN_NUMBER`, reads as not found.
