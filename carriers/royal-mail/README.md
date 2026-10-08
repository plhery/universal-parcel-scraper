# Royal Mail

UK S10 and domestic 2D-reference parcel history through the public tracking application. Automatic
tracking uses a fresh local Chromium configured by `TRACKING_CHROMIUM_PATH`. The same tracker
answers for [Parcelforce](../parcelforce/README.md), whose numbers this adapter also accepts,
including its 14-character `PB` parcel numbers.

## Retrieval

The browser opens the homepage, declines optional cookies and follows its
tracking link. Consent can reload the page, so number entry waits until it
settles. The navigation link can be covered by the site's fixed header;
the adapter follows its validated destination in the same context.

The page obtains its own CAPTCHA token for the microsummary, then `Get more
details` uses the issued API session for history. The application can refresh
an expired session itself. Tokens and cookies stay inside the browser. Opt-in browser recognition uses
the same lookup, requires dated activity and returns the history for reuse.
The carrier's launch settings and installed-version User-Agent are scoped to
this adapter.

Both replies must identify the requested `mailPieceId`. Missing or failed
details cannot become a history result; a valid empty events feed is marked
`summary_only`. Browser launch, queueing and retrieval share the caller's
deadline and cancellation signal, and the browser closes after each lookup.

## Notes

- Summary categories and individual scan codes have separate meanings. The
  sender's despatch notice and a booked collection are registrations; a
  collection or a Post Office drop-off is the acceptance.
- A delivery's scan time becomes `delivered_at`. The details reply's
  destination country becomes `destination_country`.
- Scan places lose the postcode Royal Mail appends to a Post Office branch,
  and a place given only as a postcode is dropped.
- Offset-free or invalid clocks remain in `provider_time_text`; sorting
  requires every event clock to resolve.
- Delivered wording is reduced to `Delivered`. Recipient, signature, photo,
  address, GPS and issued credentials are discarded.
- An unable-to-confirm response remains inconclusive. A generic HTTP 404
  does not establish parcel absence.

## Explicit browser-service calls

`RoyalMailTracker` also retains the experimental TRAWL path when configured
with `trawl` or `trawlUrl` and no local `executablePath`. It is excluded from
automatic routing. Constructor calls remain summary-only by default; pass
`fullHistory: true` for the separate events flow.

## Mobile API lead

The official [Royal Mail APK](https://play.google.com/store/apps/details?id=com.royalmail.app.droid)
contains the native request builders in .NET assemblies shipped in an ABI split.
Guest tracking uses `https://api-app.royalmail.com`, with
`/mailpieces/microsummary/v1/summary/{id}?returnExtendedData=true` and the separate
`/mailpieces/v3.1/{id}/events` read. Both request builders send an application
identifier, an issued anonymous bearer token and `X-acf-sensor-data` from the Akamai SDK.

The token request posts `grant_type: anonymous`, `scope: tracking` and `device_id`
to `/login/v1/tokens`. The standard host, `https://api.royalmail.net`, issues
anonymous tracking tokens with its own login application identifier. That token
does not unlock the protected tracking routes. The app uses a separate login
identifier on the protected host; requests with that identifier and the correct
body, but without SDK sensor data, receive an HTML 403. A token alone does not
establish a working HTTP-only tracking session. Application configuration and
tokens stay outside Git.

## Limitations

Akamai or an interactive CAPTCHA can block anonymous retrieval. Browser build
and network affect access; enabled universal providers can handle a failed
direct lookup. Domestic 2D references have 21 characters (two hexadecimal, seven digits,
twelve hexadecimal) or 16 hexadecimal ones. They remain low-confidence candidates because their
shape can overlap unrelated identifiers. Printed spaces and hyphens are stripped
before submission. Other barcode formats and postcode-gated delivery options are
outside this adapter's scope.

## Testing

Set `TRACKING_CHROMIUM_PATH`, `ROYAL_MAIL_LIVE_TRACKING_NUMBER` and optionally
`ROYAL_MAIL_UNKNOWN_NUMBER` outside the repository, then run
`npm run test:carriers:live -- carriers/royal-mail`.
