# Skynet Express India

Skynet Express India is an international courier from New Delhi, separate from SkyNet Worldwide
Express (`skynet-worldwide`), SkyNet Malaysia (`skynet-my`) and SkyNet South Africa (`skynet-sa`).
The adapter reads the service behind its [tracking page](https://www.skynetww.com/in-en/tracking).

## How it works

1. `direct`: `POST https://www.skynetww.com/api/tracking` with `{"awbs":["<number>"]}`, as the page's
   script sends it. It needs no cookie, token, market or browser.
2. `retry`: the lookup once more when it fails to reach the service or hangs. The first try gets half
   of the budget, so the retry fits in the rest.

- The reply holds one result per number. The adapter reads only a result whose `awb` is the number
  asked and whose `provider` is `skynetapi`, the booking system the page reads. Another number is
  indeterminate and another source a changed reply, since it would bring its own vocabulary.
- A number the service does not know is `found: false` with the `not-found` badge and no scans, and
  is not found. `found: false` with `timedOut` is the page's "Our tracking partners took too long to
  answer", a transport failure. HTTP 429 is a rate limit; a redirect, 404 or 410 means the service
  moved, not the parcel.
- Each scan has a label key, its wording and an English date with a clock. The key is
  `provider_code`, and the status map stages the keys the page translates; `information` and
  `documentation` move nothing. An unknown key is read by its wording.
- The service names no zone and the page shows the clock as it comes, so scans keep their wall clock
  as `local_time` on the carrier's clock; a scan without a time keeps its day.
- The receiver, references, remarks, service name and proof of delivery image are not read. Wording
  that names who took the parcel keeps only the verb, and the receiver's name and phone numbers are
  taken out of it.
- The page names a forwarding carrier only through its "Track on carrier" link. It becomes the
  delivery partner when that link is one catalog carrier's and the forwarding number, or else the
  number the link opens, has that carrier's shape. The link is never followed.

## Numbers

The page's field takes up to ten numbers separated by spaces, commas or semicolons, keeps their
letters and digits and checks no length or pattern. The adapter takes 4 to 40 letters and digits
with at least one digit. No public air waybill is known, so no rule suggests the carrier: it is
chosen by hand.

## Links

`www.skynetww.com/in-en/tracking?awb=<number>` (and `/in-hi/`) looks the number up as the page
opens; `id` works too. The library reads the number from those addresses.

## Limitations

- No delivery estimate, weight or instant: the service gives none.
- The found path rests on a synthetic fixture.

## Testing

`SKYNET_IN_TRACKING_NUMBER=… npm run test:carriers:live -- carriers/skynet-in`. Without it, only the
`TEST00000000` placeholder is looked up.
