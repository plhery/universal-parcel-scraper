# Royal Mail

UK S10 parcel history through the public tracking application. Automatic
tracking uses a fresh local Chromium configured by `TRACKING_CHROMIUM_PATH`.

## Retrieval

The browser opens the homepage, declines optional cookies and follows its
tracking link. Consent can reload the page, so number entry waits until it
settles. The navigation link can be covered by the site's fixed header;
the adapter follows its validated destination in the same context.

The page obtains its own CAPTCHA token for the microsummary, then `Get more
details` uses the issued API session for history. The application can refresh
an expired session itself. Tokens and cookies stay inside the browser.
The carrier's launch settings and installed-version User-Agent are scoped to
this adapter.

Both replies must identify the requested `mailPieceId`. Missing or failed
details cannot become a history result; a valid empty events feed is marked
`summary_only`. Browser launch, queueing and retrieval share the caller's
deadline and cancellation signal, and the browser closes after each lookup.

## Notes

- Summary categories and individual scan codes have separate meanings.
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

## Limitations

Akamai or an interactive CAPTCHA can block anonymous retrieval. Browser build
and network affect access; enabled universal providers can handle a failed
direct lookup. Other barcode formats and postcode-gated delivery options are
outside this adapter's scope.

## Testing

Set `TRACKING_CHROMIUM_PATH`, `ROYAL_MAIL_LIVE_TRACKING_NUMBER` and optionally
`ROYAL_MAIL_UNKNOWN_NUMBER` outside the repository, then run
`npm run test:carriers:live -- carriers/royal-mail`.
