# Kuwait Post

Kuwait Post is Kuwait's national postal service, run by the Ministry of Communications. Its
tracker on moc.gov.kw looks items up in the UPU's IPS system: Kuwait Post's own and those other
posts send to Kuwait.

## How it works

One `trawl` step: the tracker answers only after a Google reCAPTCHA v2 checkbox, so the browser
service opens `https://moc.gov.kw/en/shipment-tracking`, enters the item code, ticks the checkbox
and sends the form ([helper](../../trawl/kuwait-post-browser.mjs)). The checkbox has passed
without a picture; the service's audio solver is the fallback. The form posts the code and the
checkbox's token to a Next.js server action at the page's own address, whose id changes with
each deployment of the site, so the page sends its own. The helper binds that one request to the
whole code and returns the reply's outcome and scans. The token stays in the browser.

## Notes

- The reply does not repeat the code; the bound request is the evidence that it answers it.
- It holds items for years and lists every post's scans, the origin post's included, with the
  UPU event name and its leg, the country, the office and a wall clock without a zone, on the
  scanning office's clock. The scans keep wall clocks. The destination country is the newest
  inward scan's.
- The reply's refusals are `no_data_found` (not found), `captcha_invalid` (a challenge),
  `rate_limit_exceeded` with a wait in seconds, and `tracking_unavailable` (a transport failure).
  The site answers 404 for a stale action id, which is not the item's absence.
- The next office, the mail category, the item's condition and the signatory are dropped.

## Limitations

Without the browser service there is no lookup. The reply has no ETA, weight, sender or
recipient.

## Numbers

It takes UPU S10 item codes with a valid check digit. Kuwait Post gives its international items
numbers ending in `KW`. Generic postal detection handles these numbers, so no rule for Kuwait
Post claims them; a post's answer that names Kuwait as the destination proposes Kuwait Post.

## Links

The form sends the code with the checkbox's token and shows the reply on the same page, so there
are no tracking links.

## Testing

`npm run test:carriers:live -- carriers/kuwait-post`, with `FLARESOLVERR_URL`,
`KUWAIT_POST_TRACKING_NUMBER` and optionally `KUWAIT_POST_UNKNOWN_NUMBER` set outside the
repository.
