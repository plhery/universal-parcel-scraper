# Costco Logistics

Tracks Costco Logistics' own `1I` references for its US big and bulky delivery network,
formerly Innovel Solutions. Costco retail orders carried by another courier are outside
this adapter's scope.

The `trawl` step opens the official `logistics.costco.com/tracking?id=` page and captures
its `GET /api/tracking/api/v2/tracking/{number}` reply. The interface enforces browser-origin
access; copying its two fixed headers into a direct request does not replace that flow.
No account, recipient input or saved session is needed. Configure `FLARESOLVERR_URL` for
the browser service; enabled universal providers remain available.

Both the response's number list and its single detail must match the complete requested
tracking number. The parser keeps every dated milestone using `resultStatus`, the current
page's wording: the legacy `status` repeats the same text for arrival and out for delivery.
Scan clocks retain the delivering market's wall time; the API states no offset.
General clock resolution can add a separately labelled deduction without replacing that wall time.

Location strings can contain the delivery address, so they are omitted along with contact,
order, payment and scheduling fields. Delivery slots are not interpreted as estimates.
Nine-digit orders, work-order searches, scheduling capabilities and account pages are not
used. Only the API's exact `98` / `NODATAFOUND` envelope is a missing parcel; verification,
rate limits, empty histories and changed replies retain their failure kinds.

Run live tests with `COSTCO_LOGISTICS_TRACKING_NUMBER`, optionally
`COSTCO_LOGISTICS_UNKNOWN_NUMBER`, and `FLARESOLVERR_URL` in an environment file outside Git:

```sh
npm run test:carriers:live -- carriers/costco-logistics/adapter.live.test.ts
```
