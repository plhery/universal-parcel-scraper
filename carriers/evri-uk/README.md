# Evri UK

Domestic UK parcel history. Evri International stays under
[evri](../evri/README.md). A barcode's shape alone does not establish which
service owns it; select Evri UK explicitly or use its official tracking link.

## Retrieval

`browser` uses a fresh local Chromium through `TRACKING_CHROMIUM_PATH`. The
official page's AWS WAF SDK obtains its token and rotating API keys. The
customer search supplies parcel identifiers; the application constructs a
lookup-day URN and reads the anonymous history feed without a postcode.
Keys and tokens remain inside the browser.

The protected `/protected/keys.json` response supplies separate keys for
`api.evri.com/customer-tracking/v1/search/{barcode}` and
`tracking.platform-apis.evri.com/v1/parcels?uniqueIds={urn}`. The keys are fetched
at runtime and are not embedded in the adapter.

The browser's automation flag and installed-version User-Agent are configured
for this carrier because the protected key request rejects the default
automated launch. The context is closed after each lookup and shares the
caller's deadline and cancellation signal.

## Notes

- Search must identify one Evri parcel with the requested barcode. International
  redirects are inconclusive and are never followed.
- Both the history barcode and URN must match. Progress rails and estimates
  do not become scans; only dated tracking events establish activity.
- Known stage codes establish progress. Unknown codes remain unstaged.
- Unresolved clocks stay in `provider_time_text`; sorting requires every
  event clock to resolve.
- Recipient, address, photos, GPS, ownership credentials and delivery prose
  naming a person or safe place are discarded.

## Limitations

Calling-card numbers, postcode-gated ownership details, locations and estimates
are not projected. No TRAWL path is registered. WAF rejection or empty history
does not establish parcel absence. The deployed browser's network and build
still affect access.

The current official flow was compared with the
[MIT parcelcli implementation](https://github.com/cavit99/parcelcli/tree/48bdc78497da3dd5d5fd82aefe8a0f8a99b44650/internal/carriers/evri).
This adapter validates structured identity and history rather than rendered
text markers.

## Testing

Set `TRACKING_CHROMIUM_PATH` and `EVRI_UK_TRACKING_NUMBER` outside the repository,
then run `npm run test:carriers:live -- carriers/evri-uk`.
