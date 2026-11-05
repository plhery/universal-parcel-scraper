# Expedico

The adapter reads Expedico's anonymous public GraphQL tracking service. It binds the requested
code, the platform's own parcel id and its recorded partner reference. Own ids and the supported
partner-barcode layout work through explicit selection and tracking links; neither gets a broad
number rule or HTTP recognition candidate.

The official tracking page posts the `tracking` query with a one-item `codes` list to
`expedico.eu/api/public`. No account, session or token is needed. Only a matching `NOT_FOUND`
record with empty parcel fields becomes not-found. GraphQL errors, partial replies, verification
and malformed history retain their failure kinds. Enabled universal providers remain available.

Events are listed oldest first and returned newest first. Stated offsets are preserved; an
unoffset clock stays local. Creation is registration, hub scans are transit, and explicit
out-for-delivery wording refines the platform's coarse transit code. Arbitrary partner comments,
sender details and payment fields are omitted; weight is retained in the stated kilograms.

A partner is named only for an explicitly identified national service. Its reference remains
whole: a partner barcode is not shortened into an AWB. An unsupported downstream reference
stays in the result without triggering an invalid native handoff.

## Testing

Supply `EXPEDICO_TRACKING_NUMBER` and `EXPEDICO_UNKNOWN_NUMBER` privately:
`EXPEDICO_PARTNER_NUMBER` additionally checks a recorded partner alias.

```sh
npm run test:carriers:live -- carriers/expedico/adapter.live.test.ts
```
