# Royal Mail

Automatic tracking uses the universal providers. The browser adapter stays
available for explicit calls and tests, but normal routing and handoff discovery
exclude it because anonymous retrieval is unreliable.

## How the experimental adapter works

1. `trawl`: a real browser loads the official tracking page and captures its
   microsummary response. The page handles hCaptcha and its API session.
   Plain HTTP does not replay the browser's session.
2. The newest complete response for the requested number is parsed. The
   `mailPieceId` must match; an empty object or gateway 404 is not not-found.

Without a browser service, the adapter reports a challenge naming
`FLARESOLVERR_URL`. Calls share the caller's deadline and cancellation signal.

## Notes

- Consent preferences are set before submission because changing them can
  reload the page and clear the typed number.
- A first `401 / E0015` allows the page's own CAPTCHA refresh; repeated
  rejection ends the lookup. HTTP 429 preserves `Retry-After`.
- Summary categories establish stages; their meaning can differ from the
  same wording in an individual scan.
- Offset-free scan clocks remain unresolved because scans can be overseas.
- Delivered wording is reduced to `Delivered` because it can name a signatory.
  Recipient, signature, photo, address and GPS fields are discarded.

## Limitations

The microsummary has no event history. The separate events call requires a
fresh CAPTCHA token and is not captured. Akamai can deny the main document even
in a fresh Chromium session, or reset the API request after the CAPTCHA flow.
An interactive hCaptcha can also require manual input. Browser availability
alone does not establish reliable direct coverage.

## Testing

`npm run test:carriers:live -- carriers/royal-mail` checks the missing-browser
error. Set `FLARESOLVERR_URL` and `ROYAL_MAIL_LIVE_TRACKING_NUMBER` outside the
repository for a real lookup.
