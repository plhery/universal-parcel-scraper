# Evri UK

Domestic UK parcel history. Evri International stays under
[evri](../evri/README.md). A barcode's shape alone does not establish which
service owns it; select Evri UK explicitly or use its official tracking link.
Detection offers both services only when the barcode's last digit matches: a
letter counts as its ASCII code minus 63, mod 10, and the first fifteen
characters weigh 2, 1 from the left, summed mod 10.

## Retrieval

`direct` uses the guest tracking API of the official
[Android consumer app](https://play.google.com/store/apps/details?id=com.hermes.hercules)
over plain HTTP. `GET tracking.platform-apis.evri.com/v1/parcels/reference/{barcode}`
resolves the barcode to a parcel URN, and `GET /v1/parcels/?uniqueIds={urn}`
returns its history. Both carry the app's guest key in the `apiKey` header,
without an account, postcode or WAF token.

The app receives that key from Firebase Remote Config, under
`enterprise_tracking_api_key_android_string`. It is the same for every install
and is included in the adapter. `EVRI_UK_TRACKING_KEY` replaces it after a
rotation; an empty value disables this step.

`browser` uses a fresh local Chromium through `TRACKING_CHROMIUM_PATH` when the
guest API is refused or unreachable. The official page's AWS WAF SDK obtains its
token and rotating API keys from `/protected/keys.json`. The customer search at
`api.evri.com/customer-tracking/v1/search/{barcode}` supplies parcel
identifiers, the application constructs a lookup-day URN and reads the same
history service. Those keys and tokens remain inside the browser.

The page reads the same history as the guest API. When the guest API answers
without confirming a parcel, the page is not opened.

The browser's automation flag and installed-version User-Agent are configured
for this carrier because the protected key request rejects the default
automated launch. The context is closed after each lookup and shares the
caller's deadline and cancellation signal.

## Notes

- The reference or search must identify one Evri parcel with the requested
  barcode. International redirects are inconclusive and are never followed.
- A reference the guest API rejects or does not know is inconclusive. Evri
  drops old parcels, so an empty answer does not establish that none existed.
- Both the history barcode and URN must match. Progress rails and estimates
  do not become scans; only dated tracking events establish activity.
- Known stage codes establish progress. Unknown codes remain unstaged.
- Unresolved clocks stay in `provider_time_text`; sorting requires every
  event clock to resolve.
- Recipient, address, photos, GPS, ownership credentials and delivery prose
  naming a person or safe place are discarded.

## Limitations

Calling-card numbers, postcode-gated ownership details, locations and estimates
are not projected. No TRAWL path is registered. A refused key, WAF rejection or
empty history does not establish parcel absence. The adapter does not fetch a
rotated key from Remote Config. The deployed browser's network and build still
affect the page step.

The current official flow was compared with the
[MIT parcelcli implementation](https://github.com/cavit99/parcelcli/tree/48bdc78497da3dd5d5fd82aefe8a0f8a99b44650/internal/carriers/evri).
This adapter validates structured identity and history rather than rendered
text markers.

## Testing

Set `EVRI_UK_TRACKING_NUMBER` outside the repository, then run
`npm run test:carriers:live -- carriers/evri-uk`. With `TRACKING_CHROMIUM_PATH`
set, the page step is compared with the guest API on the same parcel.
