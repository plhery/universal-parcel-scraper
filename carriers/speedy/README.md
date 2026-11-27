# Speedy

Tracks Speedy shipments in Bulgaria, including legs Speedy hands to partners abroad, through
the endpoint behind MySpeedy's public tracker.

## How it works

1. `direct`: `GET https://myspeedy.speedy.bg/rest/public/track?id=...&language=en`, the
   endpoint the [MySpeedy tracker](https://myspeedy.speedy.bg/pub/tracking/) reads a shipment
   from. It answers only a request carrying the token of the tracker's Cloudflare Turnstile
   check: without one it answers every number with an empty object, and it refuses a token it
   did not issue with HTTP 406. Both are a challenge.
2. `trawl`: the private browser service opens the tracker page for the number, in English.
   The page passes its Turnstile check and asks the endpoint for the number with its token,
   and the service's capture helper keeps that one reply for the whole number. The token stays in the
   browser. A page that sends no request did not pass its check. Passing it takes the page
   seconds: a lookup that cannot leave the service ten seconds does not open the page and fails
   as its budget. The check turns some addresses away whatever the browser does:
   `SPEEDY_BROWSER_PROXY_URL`, an HTTP(S) proxy origin, makes the service open the page through
   that proxy, recognition included, never falling back to its own address.

www.speedy.bg sits behind a Cloudflare challenge, and Speedy's REST API at api.speedy.bg needs
a customer account, so neither is used.

The reply must name the whole requested number. For a number it does not know, the endpoint
answers HTTP 404 with MySpeedy's "the requested resource does not exist" page, which the
tracker shows as an invalid number, so that page is not found. Other 404s, blocked pages,
HTTP errors and malformed replies keep their own failure kinds. Recognition makes the `direct`
request alone, so it cannot confirm a number while the check stands. Opt-in browser recognition
then opens the tracker page alone, unless the `direct` request was throttled or malformed, and
needs dated shipment activity. Both ask only about the 63 series: a browser read for every run of
eleven digits starting with 6 would cost too much, and without one the `direct` request can only
meet the check, a failed lookup on every check of such a parcel.

## Numbers

Speedy shipment and parcel numbers are eleven digits, so other inputs are invalid without a
request. Speedy's API documentation and public reports show them starting with 6, mostly 63.
Eleven digits are shared with several carriers, so both rules are low confidence. `speedy-1`
prefers Speedy for the 63 series, which no other carrier's public numbers show, so recognition
asks it first wherever the lookup comes from. `speedy-2` only suggests Speedy for the rest of
the 6 series, where GLS, PPL and Japan Post numbers appear too, and recognition does not ask it
about them. It leaves out 600, the series of Palletways' consignment IDs.

## Notes

Each scan carries an operation code. The adapter keeps the reply's English wording and the
code, and sets the stage from the code list in Speedy's
[API documentation](https://api.speedy.bg/api/docs/). A reply without scans falls back to the
shipment's phase. Scan clocks carry their own offset. A place drops the site type Speedy writes
before the town, `gr.` in Bulgaria and `or.` in Romania, and a partner's numeric site code.

The estimate is the expected delivery day on the shipment-data scan, kept while the shipment is
on its way. The pickup point is the name of the office or locker Speedy prepared the shipment
at, once it waits there or was collected from it; contents checks at the counter do not move
it. When Speedy hands the receiving leg to ACS, the adapter names ACS and its number so the
partner can be asked about a ten-digit voucher. The delivery scan's "received from:" note names
who took the parcel, masked, and gives `signed_by`. The office address, the proof-of-delivery link
and the return waybill number are dropped.

## Limitations

A delivery postponed to a later day and the contents-check scans have no stage: the codes do
not say whether a courier tried or the parcel moved. A route MySpeedy removed would answer the
same 404 page as an unknown number. Partners other than ACS are not named.

## Links

Speedy's tracking page reads the number from `shipmentNumber` at
`www.speedy.bg/{language}/track-shipment`, as its older `begin.php` page did, and MySpeedy's
from its path at `myspeedy.speedy.bg/pub/tracking/{number}`. Such links name Speedy.

## Live test

Set `SPEEDY_TRACKING_NUMBER`, and optionally `SPEEDY_UNKNOWN_NUMBER` for a not-found shipment
number, outside the repository, with `FLARESOLVERR_URL` for the browser checks and optionally
`SPEEDY_BROWSER_PROXY_URL`, and run
`npm run test:carriers:live -- carriers/speedy/adapter.live.test.ts`.
