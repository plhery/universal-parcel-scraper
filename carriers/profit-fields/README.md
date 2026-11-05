# Profit Fields

The adapter reads EWS references from Profit Fields' anonymous guest tracking API.
Its official page posts a one-item `trackingNumbers` list to `8dt.com/api/tracking/query`,
without an account, cookie jar or verification token. The query identity, record id and
tracking number must agree before history is accepted. HTTP recognition uses this same
bounded request; the supported EWS layouts remain low-confidence suggestions until confirmed.

Only the number-bound `found: false`, `status: notfound` record with empty history and
parcel fields means not-found. API errors, refusals, rate limits and malformed replies
retain their failure kinds. Enabled universal providers remain available.

The detailed timeline is returned newest first. Each scan's stated UTC offset is preserved;
an unlabelled clock stays local. The separate process diagram is a summary, not extra scans.
Sending a parcel to a local carrier or processing it at a destination facility is transit.
Only explicit out-for-delivery wording refines the broad last-mile code.

The field called `carrier` contains a commodity label and does not identify a delivery company.
The recorded transfer reference stays whole; its issuer can propose a separate confirmation.
Customer order references, diagram details, recipient fields and contact suffixes are omitted.
The delivery signature date and elapsed-day counter are not an estimate.

## Testing

Supply `PROFIT_FIELDS_TRACKING_NUMBER` and `PROFIT_FIELDS_UNKNOWN_NUMBER` privately:

```sh
npm run test:carriers:live -- carriers/profit-fields/adapter.live.test.ts
```
