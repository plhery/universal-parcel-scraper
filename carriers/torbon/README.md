# Torbon

Tracks waybills of Torbon (拓邦国际, 浙江拓邦供应链管理有限公司), a Yiwu forwarder that carries goods by
sea, rail and air to Amazon warehouses in the United States and Europe. Its site is torbon.com; its
tracking page frames Torbon's own tenant of the rtb56 platform at `oms.torbon.com`. The request
helpers are shared with [YYPOST](../yypost/README.md).

## How it works

1. `direct`: one GET to `webservice/Service.ashx` on `oms.torbon.com` over HTTPS (`method=track`,
   `param` the JSON of the query, `key` the Base64 of that text's MD5 in hexadecimal), which answers
   JSONP with one entry per number and its scans, newest first. An unknown number gets `success` 0
   and "No query to track information", the only not-found.
2. `retry`: the same request once more after it fails to reach the tracker or hangs.

The tracking page asks its visitors to pass a slider before it sends the lookup; the lookup itself
needs no slider, session, cookie or account.

## Notes

- The adapter asks only for waybills of the one layout seen, TB, ten digits and CN, and reads only
  the entry whose `server_hawbcode` is the number asked.
- Every scan states `+08:00`, the rows for the port and the warehouse in the United States too, and
  each scan gets that instant. Those rows are typed in China on China's clock: the arrival at Los
  Angeles and the container's collection, read so, fall on the US days the rows before them
  expected.
- Torbon's system rows carry a code (IR, AF) and English wording. The rows its staff type, from
  loading the container to the delivery at the warehouse, are Chinese without a code and name the
  days they expect as month.day; the status map reads such a day as an ellipsis. The delivery
  row, 已送仓, is the parcel's end: the goods reached the Amazon warehouse.
- The merchant's reference and the proof-of-delivery image are never read. The sample's reply
  names no onward carrier or number, so the result gives none.

## Limitations

- No delivery estimate, weight or service name.
- Waybills of other layouts the firm may issue are refused until one is seen.
- Rows typed in other words than those recorded fall to the shared wording rules.

## Numbers

The sample is the test number kuaidi100's carrier list gives the firm. No detection rule claims the
layout.

## Links

The tracking page takes no number in its address: it shares a parcel through an encrypted code, so
no portal link is published. The search page is torbon.com's tracking page, and the help link its
contact page.

## Testing

`npm run test:carriers:live -- carriers/torbon` tracks the public sample, or the number in
`TORBON_TRACKING_NUMBER`, and checks that an invented number, or the one in
`TORBON_UNKNOWN_NUMBER`, reads as not found.
