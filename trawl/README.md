# Optional TRAWL browser service

Some carriers and universal providers only answer a full browser session. This image extends
[TRAWL](https://github.com/germondai/trawl) with identity-bound capture for DHL Express, FedEx, UPS, USPS, Royal Mail,
Australia Post, YunExpress, 17TRACK, SF Express, WanbExpress, XPO, Asendia, DHL Poland, Magyar Posta, Poste Italiane, SwiftX, China Post and ZTO. The adapter checks the captured response against
the requested parcel. A solved challenge alone is not tracking history.

USPS also captures its tracking request's redirect to the official outage page.
That redirect can leave the verification wrapper blank; retaining it lets the
adapter distinguish temporary unavailability from an unresolved challenge.

Spee-Dee also uses the service's HTTP tier after a refused direct connection; the benefit
is the service's network, and no browser is launched. MTCaptcha (Hongkong Post)
needs handling that this image's solvers do not provide; its
[documentation](../carriers/hongkong-post/README.md) describes the verification flow.

## Sessions

The service reuses browser sessions, never parcel responses. FedEx keeps one verified context
per pooled browser and discards it on expiry, mismatch or failure. TRAWL's named sessions do not
replace it: FedEx's API refuses the tracking call a kept session page makes for a tracking URL,
and the untrusted input of a session eval never sends one. Australia Post,
DHL Express, SF Express, WanbExpress, XPO, Asendia, DHL Poland, Magyar Posta and ZTO use fresh contexts.
SF Express solves GeeTest's slider locally and asks for at most two other puzzles when it
cannot read one.
ZTO solves Dingxiang's slider and ordered-character challenge locally, with at most two
concurrent offline OCR workers; a request waits for a free worker within its deadline. Each
worker ends with its request and retains no images. A puzzle the helper cannot read is
swapped for another through Dingxiang's refresh control, at most twice per lookup.
The `zto.verification` warning records how each run ended. For each puzzle it gives the
kind, the slider's match score or the OCR's confidence, boxes and time, and whether
Dingxiang accepted the answer. It has no images, answers, tokens or tracking numbers, and
the adapter reports the same outcome as its challenge reason.
Verification failures and the public tracker's incomplete history still need enabled providers.
SwiftX emits a `swiftx.verification` warning for an observed image challenge or
an unresolved prepared page, using fixed puzzle types, outcome labels and counts.
Analysis labels distinguish worker limits from an uncertain image match.
It retains no images, answers, tracking identifiers or verification tokens.
China Post reads its ordered-character prompt offline and takes click positions from the
shared character worker; a worker failure stays unreadable. It submits the anonymous preview form
and retains only scan state labels and local clocks. If the entry form fails to load,
it reloads the official page once before sending any tracking request. An identified
unsolved verification on an HTTP 200 page reaches the adapter as a challenge,
with its phase retained in a `china-post.verification` warning.
The `china-post.form-reload` warning records whether the form recovered and
a bound scan reply arrived, without identifiers or page content. Its two-scan guest window stays marked
incomplete; the helper enters no phone digits and signs into no account.
DHL Poland uses TRAWL's native checkbox and audio solver.
Poste Italiane uses that solver only after its tracking API requests a CAPTCHA. Its page
submits the issued token and the helper captures the matching history, keeping the earlier
refusal and excluding verification tokens and recipient fields. A disappearing widget does
not override a tracking request already in flight: its response and body finish within the
same deadline. Failed or unfinished later requests stay failures. The fixed-label
`poste.verification` log records native solver outcomes and pending-request counts without
tokens, parcel identifiers or page text.
Its scoped native modules replace upstream raw debug logs with fixed events.
It submits its history form after reCAPTCHA verification and returns only
the waybill and scan fields, excluding recipient acknowledgements and verification tokens.
Asendia waits for its own Turnstile callback to enable search and binds the captured POST
to one whole identifier. Given a delivery postcode in the fragment, it opens the scans through the page's dialog; otherwise recipient verification leaves the current status only. XPO scopes the checkbox
solver to its visible widget while the public client completes verification and tracking.
Magyar Posta renders the Posta app's invisible reCAPTCHA Enterprise widget on the app's WebView
origin, answers its audio challenge with TRAWL's speech-to-text and posts one number to the app's
guest list, keeping the reply without names, phone numbers or the token. Its fallback opens the
tracker the public page frames, solves the checkbox there, searches one number and keeps the
result page its search redirects to, without scripts or form tokens.
DHL Express waits for the public
page to complete verification and repeat tracking after an intermediate HTTP 428.
17TRACK submits a supplied postcode through the site's form and binds the capture to
the number and postcode in its outgoing request.
UPS binds the browser POST to one tracking ID and retains the latest bounded
response sequence, including refusals after the body extraction budget is spent.
SwiftX's page clears Cloudflare's managed challenge and offers a slider when Turnstile
cannot complete. Its scoped helper matches cutouts, image seams, circular rotations and
ordered icons offline, rejecting ambiguous matches. It uses the page's pointer handlers,
with at most two puzzles; verification tokens stay in that context.
The page then posts one GraphQL query; the helper keeps
the decoded reply only for the query naming the whole number in the page's address.

Redis is optional. It stores cookies and user agents with a TTL, not tracking history, and a
cached session that fails falls back to a fresh browser. Do not expose Redis.
Keeping a browser session does not make an application CAPTCHA token reusable;
the site can require fresh verification for each action.

## Run it

```sh
docker build -t universal-parcel-scraper-trawl trawl
```

A host that keeps a Dockerfile without its build context, such as Coolify, takes the output of
`node trawl/render-coolify.mjs` instead: the same image with its sources embedded. It labels
the image `org.opencontainers.image.revision` with the commit it was rendered from, followed by
`-dirty` when the sources differ from that commit.

Keep the service on a private network. Pass its URL as `trawlUrl` to the library, or as
`FLARESOLVERR_URL` to the CLI and the HTTP server. `TRACKING_CHROMIUM_PATH` enables the
separate local Chromium transport.

`REDIS_URL` configures the session cache. `AUSTRALIA_POST_BROWSER_LOCALE` overrides the
browser locale for Australia Post, and `FFMPEG_PATH` selects SF Express's PNG decoder.

`BROWSER_SHUTDOWN_DRAIN_MS` lets accepted lookups finish when the container stops; by default
TRAWL interrupts them. It exits by force 30 seconds after the drain, so give the container a
stop timeout of the drain plus 30 seconds, or the supervisor kills it mid-drain. `GET /metrics`
reports the browser pool to Prometheus.

The image sets `LOG_LEVEL=warn`. TRAWL's request log includes the page path, where some
carriers put the parcel number; `LOG_LEVEL=info` turns that log on. Each tier that fails, is
blocked or times out logs a `tier.failure` warning with the page's host, its status, the page's HTTP status and
the error it caught: the error's name and the first line of its message, up to 200 characters,
without URLs or query strings and with runs that could be identifiers masked.
FedEx's captured API refusals leave the browser tier successful. A separate
`fedex.api-refusal` warning records the API status, browser slot, session reuse,
session age, time since the browser's previous lookup and verified lookup, and
lookup count on that browser. It contains no parcel identifier, response body or cookie. The
`fedex.session-end` warning records why a context closes, its age and lookup count,
and whether it ever returned verified tracking. It distinguishes expiry and browser
loss from an unreadable or inconclusive reply, without identifiers or response content.

TRAWL drops a reply that reaches its request deadline. The image ends its own waits and
TRAWL's CAPTCHA solvers 2.5 seconds before it, so a page behind an unsolved widget and
the replies already captured are still returned.

TRAWL's reCAPTCHA audio solver stops as soon as Google's challenge frame shows its
automated-traffic page or refuses an answer. It reads both from the frame's class names, so a
widget in any language counts, and it requests no more audio from a refused address.

## Tests

`npm run test:scripts` runs the offline capture and session tests. Live adapter tests need a
running browser service and references supplied through the environment. Browser challenges
and upstream limits can still prevent retrieval.

## Upstream releases

A nightly workflow builds this image on each new TRAWL release and reports in an issue
whether the patches still apply. `node scripts/trawl-upstream.mjs --write` moves the pins
to that release. Compare the service's answers with the pinned release before deploying:
a build does not show a changed deadline or a field missing from a reply.

## License

This derivative is [AGPL-3.0](LICENSE), separate from the core package's Apache license.
[Matching source and redistribution](SOURCE.md).
