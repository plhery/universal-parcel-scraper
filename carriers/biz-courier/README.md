# BIZ Courier

Select BIZ Courier to track one consignment through the English Track iT page. The adapter
matches the full number in the results table and reads the history next to that row.

The scans use the offsets in the page's machine-readable clocks. The partner event code
distinguishes a delivery run from an in-transit assignment. Secondary comments, messages,
recipient details and partner routing stay outside the result.

Consignment numbers are SWS and eight digits, which rule `biz-courier-1` suggests BIZ Courier
for.

Set `BIZ_COURIER_TRACKING_NUMBER` and run
`npm run test:carriers:live -- carriers/biz-courier`.
