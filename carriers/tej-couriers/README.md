# Tej Couriers

Tej Couriers covers domestic consignments in its Indian network.

## Retrieval

The official tracking page reads one whole consignment through
`GET /api/tracking/php/tracking.php?tracking={number}` on `www.tejcouriers.com`.
It needs no login, session or CAPTCHA. The JSON envelope contains a nested `PayLoad`
whose consignment identity must match before any history is accepted.

Scan clocks have no offset and remain local wall clocks. Empty activities do not advance
tracking freshness. Run sheets indicate out for delivery; a bare pending notice keeps the
preceding stage. Recipient details and proof-of-delivery fields are omitted.

## Limitations

Expired history can produce an explicit missing reply. Credential-like errors and unfinished
payloads stay inconclusive. A network failure gets one bounded retry; refusals and rate limits
remain distinct so enabled providers can recover. Eight-digit consignments share their shape
with many carriers, so this adapter serves Tej Couriers when selected.

## Testing

`TEJ_COURIERS_TRACKING_NUMBER` supplies one live input from outside Git:

```sh
TEJ_COURIERS_TRACKING_NUMBER=… npm run test:carriers:live -- carriers/tej-couriers/adapter.live.test.ts
```
