# Huaxin Supply Chain

Huaxin Supply Chain (华欣供应链, also 华欣物流), based in Beijing with offices across China, moves freight by road
between businesses. Its site is chinastarlogistics.com. Tracked through the service its tracking page asks.

## How it works

1. `direct`: one `POST https://mip.chinastarlogistics.com:2443/openApi_v2/golbalLinkNodeGwAndFast100?danhao={number}`
   with the JSON body `{"cecNo":"{number}"}`, as the page's first request. It needs no cookie, token, account or
   browser. The reply is JSON: `status` "0" and the waybill's nodes in `data`, newest first, each with the waybill,
   the shipper's order, a node code and name, a clock, the operator's place and a text.
2. `retry`: one more request when the first fails to reach the service or hangs. The first gets half of the
   budget, so the retry fits in the rest. The server is sometimes slow to accept a connection from abroad, so the
   default budget is 20 seconds.

- `status` "0" with no `data` and a message starting 暂无数据 is the answer for a number the service holds nothing
  under, which is not found. The same message answers a request with no number, so it says nothing more. Another
  status or message, or an empty list, is inconclusive; HTML is a browser check or a changed route, and a non-200
  reply is a moved route or a request the service refuses.
- The service finds a waybill by its own number or by the shipper's order. Every node must carry the number asked
  as one or the other; a reply with another number's node is refused whole. Asked by an order, the result names
  the waybill as `canonical_tracking_number`, and an order of several waybills is inconclusive with the reason
  `several_parcels`.
- After an empty answer the page asks again with `{"saleNo":"{number}"}`, a sales order. No public number shows
  that field finding one `cecNo` does not, so the adapter asks once.
- The site's home page sends numbers starting 00 to an older system on mis.chinastarlogistics.com, for which no
  public number is known; the adapter refuses them as invalid input rather than read the new service's empty
  answer as not found.
- The tracking page is on plain HTTP only, so the catalog links no page.

## Notes

- `operationTime` is a wall clock with no zone. It is dated on China's clock, the firm's, with `carrier` as the
  basis; the service's own error replies stamp China's time. A clock that would date a node after the lookup keeps
  its wall clock alone.
- `linkNodeCode` is kept as the scan's code and sets the stage through `statuses.json`.
- The text repeats the operator's or dispatcher's name and the clock before the status. The wording is the part
  after its last 状态：, without the brackets, such as 已运抵收货单位待签收 or the warehouses a transfer names; a
  text with no status, or one that names a person or a phone, shows the node's name instead.
- `operationPosition`, a city or district, is the location.
- `operationMan`, `signMan` and `signPic` (the operator, the signer and a picture of the signature) are never
  read. The shipper's order is not kept.

## Limitations

- No delivery estimate, weight, service name, sender or recipient.

## Numbers

Waybills are Y, two letters for the office, S, the date and five digits; the samples are from the Beijing and
Guangzhou offices, and no other carrier's rule or sample takes that shape, so detection names Huaxin for those two
offices. Shippers' orders are bare digits, which many carriers print, so the adapter answers explicit selection
for them and for any number of 6 to 40 letters and digits. The samples and their sources are in
[`numbers.json`](numbers.json).

## Testing

`npm run test:carriers:live -- carriers/chinastarlogistics` tracks the public sample, or the number in
`CHINASTARLOGISTICS_TRACKING_NUMBER`, and checks an invented waybill, or the one in
`CHINASTARLOGISTICS_UNKNOWN_NUMBER`, reads as not found.
