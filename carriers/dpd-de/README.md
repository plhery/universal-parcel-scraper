# DPD Germany

DPD parcels tracked through the German business unit. DPD Switzerland remains
[dpd](../dpd/README.md), and DPD France is [dpd-fr](../dpd-fr/README.md).

## How it works

1. `direct`: the myDPD guest API, using `businessUnit=DPD-DE`. It shares the
   installation, Remote Config and OAuth protocol with the Swiss adapter.
   Tokens are cached per instance; all requests share the caller's deadline
   and cancellation signal.

## Notes

- Both the requested number and returned parcel identity must match.
  Empty history is inconclusive; malformed or undated events are schema errors.
- A delivery postcode is optional. A rejected postcode gets one unverified
  lookup. Unverified replies omit places and the delivery window.
- The group API knows parcels across countries. A matching number does not
  prove a German destination, so this adapter is not a recognition candidate.
  An explicit current country outside Germany is inconclusive for this service.
- Scan offsets take precedence over local clocks. Germany and Switzerland
  share the same civil-clock rules for the supported tracking history.
- The Swiss page fallback is not used for German lookups.

## Limitations

Recipient details, addresses, delivery proofs and preference links are discarded.
No UK service is inferred from a German result.

## Testing

`npm run test:carriers:live -- carriers/dpd-de`. Set
`DPD_DE_TRACKING_NUMBER` outside the repository for a positive lookup.
