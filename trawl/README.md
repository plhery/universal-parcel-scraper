# Optional TRAWL browser service

Some carriers and universal providers only answer a full browser session. This image extends
[TRAWL](https://github.com/germondai/trawl) with identity-bound capture for DHL Express, FedEx, UPS, USPS, Royal Mail,
Australia Post, YunExpress, 17TRACK, SF Express, WanbExpress, XPO, Asendia, Correios Brazil, DHL Poland, Magyar Posta, Poste Italiane, SwiftX, China Post, JD Logistics, Ozon, MailAmericas, LBC Express, Evri UK, DPD UK, J&T Express Brazil, Onlog Express, Viettel Post, ZTO, HuaHan, Correos de Costa Rica, DAO, PasarEX, Peddler, Rohlig SUUS Logistics, Onex, Neighbour Express, Magic Trans, APM Logistics, Gintracom, Transglobal Express, Turkon Line, Hapag-Lloyd, Biman and Kuwait Post. The adapter checks the captured response against
the requested parcel. A solved challenge alone is not tracking history.

MailAmericas lets the official page complete its AWS check in a fresh context, then captures
only tracking POSTs for the requested number. It retains bounded refusals and retries without
cookies, challenge tokens, recipient fields or rendered pages.

Onlog Express uses the canonical guest form and its own Turnstile callback. When the CDN
loads before the page defines that callback, the helper invokes the existing initializer
once if its widget is still blank. It captures only the whole-reference guest request and
projects its reference heading and scan rows, preserving minute wall clocks.

DAO opens its English guest page in a fresh context. It waits for the native interactive
Turnstile frame before bounded checkbox clicks, then captures the exact whole-reference GET.
The page owns its nonce, timing header and single-use token; only selected tracking fields leave
the context. An unfinished widget remains a challenge.

InPost UK opens its result page for one number in Yodel's layouts. The page runs its own Turnstile
and posts the number with the token to `/tracking/api`; the helper clicks the widget's checkbox only
when Turnstile asks, at most three times, and captures that one post for the whole number: 200 for a
parcel, 404 with `not_found` for a number the tracker does not know. It passes on the parcel's statuses,
destination type and country, delivery window and scans with their code, words, time and town, and the
key names of the parcel and its first scan, without names, addresses, postcodes or the token.

Peddler fills its tracker's form from the address, lets the page's own Turnstile give the form its
token and submits it, at most twice when a token is refused. The tracker sets a cookie for that one
number, and the page then asks for its data; the helper captures that request alone and passes on
the events without courier names, their positions or the delivery address.

Rohlig SUUS Logistics opens the guest order page for the number, which gets its own invisible
reCAPTCHA Enterprise token and asks for the order. The helper captures that lookup alone, an empty
204 for a number the tracker does not know and an empty 500 for a missing token, and passes on the
events and countries without addresses, names, references or documents. When reCAPTCHA scores the
token too low, the tracker answers 400 and the helper reloads the page once for a new token.

APM Logistics opens its tracker page for the waybill, `cek-resi?resi=<waybill>`. The page gets
its own reCAPTCHA v3 token and posts it with the waybill. The helper captures that post alone
and passes on the checkpoints, their towns and branches, the hubs and cities of origin and
destination and the delivery status, without names, addresses, phones, rates, staff or
couriers. A token reCAPTCHA refuses gets `Google Captcha Error`, and the helper reloads the page
once for a new token.

Onex opens its English tracker for the number once Cloudflare lets the page load, and the page
submits the number from its address. The helper captures that lookup alone and passes on the
events and the import and export dates without weights, boxes, prices, taxes or another carrier's
scans.

Transglobal Express opens its tracking form once Cloudflare lets it load, types the whole
reference and lets that one post through. The form redirects a reference it knows to the result
page of that order; the helper checks that the redirect names the reference's order number and
follows it. It passes on the legs and dated rows alone, or the form's `Order not found`. The
redirect's address carries the order's delivery postcode, which no row or log keeps.

Magic Trans opens its tracker for the number, drags the thumb of Yandex's SmartCaptcha slider
across its track and, once the check issues its token, clicks the page's button, which posts the
number with the token back to the same address. The helper aborts other lookups and the page's
maps and analytics, captures that lookup alone, and passes on the status, the dated rows, the
transport and delivery kinds and the terminals' cities from the answered page, without weights,
cargo names, payment, addresses or phones.

Gintracom opens its Ecuador tracker for the guide once Cloudflare lets the page load. The page
reads the guide from its address, gets an invisible reCAPTCHA token and posts both. The helper
captures that lookup alone and passes on the status, the stage and the dated rows, without the
shop, the contents, the amount to collect, the return risk or the delivery-day choice. A token
reCAPTCHA refuses gets 422, and the helper reloads the page once for a new token; when the check
shows its pictures instead, the helper stops and says so.
Turkon Line opens its tracking page once Cloudflare's check reloads it, types the number into
the page's search box and presses Enter. The page then asks for the booking's milestones and for
each container's moves, as a guest. The helper lets only those two lookups for the whole number
out, captures the containers' moves, and passes on the events and ports without weights,
dangerous goods, reefer settings, vessels or voyages.
Speedy opens MySpeedy's English tracker for the number. The page passes its Turnstile check and
asks the tracking endpoint for the number with its token. The helper keeps that one reply, the
missing-resource page of a number Speedy does not know, or the 406 of a refused token.
DPD Romania opens MyDPD, the same tracker on DPD Romania's host, for the waybill and keeps its
one reply the same way.
Hapag-Lloyd opens its tracking page with the whole reference in the page's route. Cloudflare's
check and then the page's own Turnstile may each show their checkbox; the helper clicks one only
when nothing covers it, at most three times. The page then asks the tracking service for the
reference's moves with its Turnstile token. Only that request for the whole reference goes out, at
most twice, and the helper passes on the containers' moves, places and means of transport, or the
error key of a refusal, without container types, weights or voyages.

Neighbour Express opens the return-label guest page in a fresh context and lets its native
reCAPTCHA v3 callback submit the whole reference. The helper captures that single POST and
reads the browser's decoded response, preserving its native verification refusal or selected
identity, milestones and stated offsets. Contacts, notes, verification tokens, cookies and page
HTML remain in the context. It does not solve the separate AJ image challenge.

Viettel Post opens its public guest form, completes its native reCAPTCHA and lets the page
sign the request with its fresh browser key. The capture binds the whole waybill and retains
verification refusals before an automatic retry. A configured proxy carries the entire fresh
context. Only selected identity and scan fields leave it; keys, tokens, contacts and rendered
pages stay out of the result. Audio cooldowns remain shared, with a checkbox-only attempt
while audio is unavailable.

Pro Carrier, Delnext, MRL Global, AIT Worldwide, Hitch, PBT, Celeritas, Hi-Trans Express,
Interparcel and Aquantuo also use the ordinary browser tiers after a challenged HTTP lookup.
Their adapters read the rendered page through the same identity checks as HTTP; no carrier
helper or image rebuild is needed.
Trendyol Express uses those tiers for its public shipment page and reads the complete
collapsed timeline without recipient details or delivery controls. HIT Cargo uses them for its
tracker's JSON reply, and reads an unknown guía's HTTP 404 reply with its body.

Ozon's helper waits for its guest form after browser verification, then reads the matching
posting API through a bounded decoded stream. It returns the full timeline without retaining
cookies or the rendered page. Ozon Rocket references are outside that helper's scope.

USPS also captures its tracking request's redirect to the official outage page.
That redirect can leave the verification wrapper blank; retaining it lets the
adapter distinguish temporary unavailability from an unresolved challenge.
A cookie session USPS sent there is dropped instead of replayed, and a fresh browser sent
there saves none ([usps-tracking.mjs](usps-tracking.mjs)). USPS sends the first read of every
browser session there, so tracking reads go through TRAWL's named sessions that USPS has already
let through, prepared through the read's proxy when it names one (see Sessions).

Spee-Dee also uses the service's HTTP tier after a refused direct connection; the benefit
is the service's network, and no browser is launched. MTCaptcha (Hongkong Post)
needs handling that this image's solvers do not provide; its
[documentation](../carriers/hongkong-post/README.md) describes the verification flow.

Track123 runs Tencent's invisible check on a blank document served at the address of the courier page the request names, in a fresh context, then sends the page's query for that courier and the whole number, with the check's ticket, and its polls from that document. The courier page itself takes longer to load than the lookup. Only history fields leave the context and the ticket is used once. The service keeps Tencent's script and style files between lookups, for as long as their cache headers allow and a day at most, as a browser that came before would: reading them takes longer than the rest of the lookup, and the network that serves them drops connections from the server in bursts. A check that asks for a visitor's answer ends the lookup as a challenge.

LBC Express binds the public page's main-frame tracking POST to the whole label and
decodes its compressed response. Its bounded capture retains automatic verification
retries and returns selected identity and scan fields without recipient details,
nonces, cookies or a page archive.

Evri UK binds the whole-barcode customer search, its parcel identifier and the
lookup-day history URN in a fresh guest context. It reads decoded tracking
responses even when their content length is absent, preserving bounded retries
and final refusals. Only selected history leaves the context, without page
HTML, cookies, rotating keys or ownership details.

DPD UK opens its public tracker for the whole number in a fresh context. The page searches
the reference, then runs an invisible reCAPTCHA before it opens the parcel, and uses the
token only to log in with a postcode. The helper opens the page's parcel route for the code
the search issued instead, which reads the detail and events without a token. It keeps those
reads alone, decoded, and stops at the first refusal or 404. Responses for codes the search
did not issue for the number are dropped. Only the JSON, its status, content type and
`Retry-After` leave the context.

SiCepat's helper reproduces its official app's inline guest WebView, at the app's configured
origin, rather than fetching the challenged homepage. It returns one fresh reCAPTCHA v3
callback in a tagged client envelope, without a tracking number or cookies. The SDK uses
it once through its own supplied HTTP transport for the whole-waybill app lookup. This
bootstrap output is separate from a captured tracking reply.

## Fresh contexts

Helpers that read one lookup in one fresh context share its lifecycle through
[helper-context.mjs](helper-context.mjs): it opens the context, through the request's proxy
when one is given, creates the page, installs the outbound policy, runs the carrier's steps
against the deadline and the request's signal, and closes the context within a cleanup
window, asking for a new browser when the close does not finish. A context that arrives late
is closed on arrival. The carrier keeps its own capture, observes before navigating, and
builds its reply on failure before cleanup, so a challenge seen at the deadline is kept. A new
helper of that shape should use it. Helpers that keep a session or page, reopen contexts or
pages within a lookup, or prepare the context before its page keep their own lifecycle.

## Sessions

The service reuses browser sessions, never parcel responses. FedEx keeps one verified context
per pooled browser and discards it on expiry (`FEDEX_SESSION_IDLE_MS`, two hours idle, or
`FEDEX_SESSION_MAX_AGE_MS`, eight hours old), mismatch or failure. The edge refuses new
sessions far more often than kept ones, and a kept one it refuses costs no more than a new one. A context is verified when the
edge accepted its last lookup and FedEx answered for that number, with tracking or with its
answer that it has none; each lookup still submits and captures its own request. A refusal,
an unreadable reply or another number's reply ends it. TRAWL's named sessions do not
replace it: FedEx's API refuses the tracking call a kept session page makes for a tracking URL,
and the untrusted input of a session eval never sends one.

TRAWL replaces a browser after `BROWSER_RECYCLE_AFTER_CONTEXTS` new contexts, which ends
its FedEx session; a new session is usually refused. A browser with a verified FedEx session
is held past that count while the session works, at most once. The hold ends, and the
browser is replaced as usual, when the session ends, after `FEDEX_HOLD_MAX_LOOKUPS` (120)
more lookups (FedEx's and other carriers' new contexts) or `FEDEX_HOLD_MAX_AGE_MS` (an
hour) after the pool first asked to replace it. No browser is held while the container's
working set is above `FEDEX_HOLD_MAX_MEMORY_SHARE` (70%) of its memory limit, or while the
limit is unreadable. That is the cgroup reading TRAWL's pool already takes; Firefox has no
cheap per-browser figure. Recovery replacements, TRAWL's memory pressure check and other
browsers keep TRAWL's policy. The constants are in [fedex-session.mjs](fedex-session.mjs).
A `fedex.browser-hold` warning records each hold that starts, ends or is declined, with
its reason, browser slot, lookups, age and memory share.

USPS reads go through named TRAWL sessions, `usps-tracking-<n>`, which keep their context and
their browser. USPS refuses each session's first read and lets only some sessions through,
whatever the browser or address; one it lets through keeps loading tracking for a while. So
sessions are prepared in the background, away from any lookup: a new one reads the last requested
tracking page up to three times, ten seconds apart, and is kept once tracking loads. Two are kept.
A lookup reads through one of them, and once more through the other when the first turns it away.
A session is replaced after two refusals in a row, after two hours, or when its browser goes.
After four new sessions in a row that USPS let none through, none is opened for two minutes, a
rest that doubles up to sixteen minutes until one is let through, and none is opened once no
lookup has come for half an hour. A lookup waits up to twenty seconds for a session
being prepared; with none ready it fails with HTTP 503 without reading, since a fresh context's
read is always refused. A `usps.session` warning records each session created, let through and ended, with its
reason, reads and age, and each rest. It also records each trial read with what it met (tracking,
USPS's outage page, another page, an error or the read's timeout), a session that could not be
opened with its status, and those counts on a session USPS did not let through, so refusals can be
told apart by cause.

USPS refuses one address's sessions for hours while it lets another's through, so a read that names
a proxy has sessions of its own, `usps-tracking-proxy<n>-<n>`, prepared through that proxy, kept and
rested apart from those on TRAWL's own address. Up to two proxies get sessions; a read through any
other uses the pool. Their `usps.session` warnings carry `route: "proxy"`, never the proxy's address.
A proxy is paid by the byte, so its exit keeps one session, rests after two USPS refused, and
prepares none once no lookup came for five minutes.

Each USPS session runs in a browser of its own: the pool's Camoufox binary launched through
`playwright-core` without camoufox-js's generated fingerprint, which USPS's bot check refuses. The
browser closes a minute after its session has no context left.

With `USPS_WARMUP_NUMBER` set to a public USPS sample and `USPS_WARMUP_PEER` to the network alias
clients use, a new container prepares these sessions before it opens its port while another
container under that alias answers its health check: it reads that number's tracking page as a
lookup would, and listens once both sessions are kept, after five minutes when USPS refuses new
ones, or as soon as the other container stops answering. Meanwhile the container it replaces keeps
serving, since a client that finds the new port closed connects to the other address under the same
alias, and a rolling deploy stops the old container only once the new one answers its health check.
A container started alone, after a reboot or a crash, opens its port at once and prepares the
sessions in the background. Give the health check room for the wait (start period plus retries
times interval above five minutes). A `usps.warmup` warning records whether the port was held and
how the wait ended, with its duration.

Australia Post, DHL Express, SF Express, WanbExpress, XPO, Asendia, Correios Brazil, DHL Poland, Magyar Posta and ZTO use fresh contexts.
Australia Post also uses its capture helper through a request's proxy, keeping that route's
browser settings. Its exact guest query starts without the generic page's challenge waits;
custom session state or explicit page-readiness options keep the ordinary browser path.
Its guest request runs in the page's execution world, preserving DataDome's native fetch wrapper;
the worker's isolated evaluation world has a different fetch. Intermediate API refusals stay in
the response sequence while that wrapper verifies and retries within the same deadline.
Through a proxy its page loads only the document, DataDome's requests, the tracking request and
an app module whose key the process has not read; everything else is refused to save proxy bytes.
A request's proxy carries WanbExpress's whole fresh context; through it the helper runs only
the page's passive check and leaves a visible checkbox unsolved.
Veho's helper opens the tracker's home page, with no tracking number, in a fresh context and
returns only the guest attestation the page obtains: the token and its lifetime, or the
refusal's status. A request's proxy carries that whole context.
SF Express solves GeeTest's slider locally and asks for at most two other puzzles when it
cannot read one.
ZTO solves Dingxiang's slider and ordered-character challenge locally, with at most two
concurrent offline OCR workers; a request waits for a free worker within its deadline. A
worker reads a picture's characters in parallel, with the scores a serial read gives. Each
worker ends with its request and retains no images. A puzzle the helper cannot read is
swapped for another through Dingxiang's refresh control, at most twice per lookup.
Dingxiang shows a refused puzzle again unchanged, so the same control asks once for
another picture after each refusal; the warning counts these refreshes.
The `zto.verification` warning records how each run ended. For each puzzle it gives the
kind, the slider's match score or the OCR's confidence, boxes and time, and whether
Dingxiang accepted, refused or escalated the answer to secondary verification.
Puzzle readiness, analysis, input and verification have separate timings. Each verdict
stays bound to its submitting request, and an unfinished later challenge keeps its timeout.
Fading puzzles wait until visible, and coordinates are discarded if the puzzle changes
during analysis. The warning has no images, answers, tokens or tracking numbers, and
the adapter reports the same outcome as its challenge reason.
Verification failures and the public tracker's incomplete history still need enabled providers.
SwiftX emits a `swiftx.verification` warning for an observed image challenge or
an unresolved prepared page, using fixed puzzle types, outcome labels and counts.
Analysis labels distinguish worker limits from an uncertain image match.
It retains no images, answers, tracking identifiers or verification tokens.
China Post reads its ordered-character prompt offline and takes click positions from the
shared character worker; a worker failure stays unreadable. Its puzzles draw solid characters
turned at most a quarter turn, so it asks the worker for a quick read first: one reader over
those turns of each plain crop. An order that does not clearly lead the next one gets the
worker's full read. It submits the anonymous preview form
and can refresh a completed but unreadable prompt once through the official widget,
within the same two-puzzle limit and deadline. Worker errors, cancellation and timeouts
do not trigger that refresh. The replacement must have a new identifier and background,
and its image must be displayed before solving it. A `china-post.prompt-refresh` warning
records the recovery's bound scan count without puzzle content. The helper
retains only scan state labels and local clocks. An entry form that fails to load
ends the lookup; reloading the page rarely brought it back. An identified
unsolved verification on an HTTP 200 page reaches the adapter as a challenge,
with its phase retained in a `china-post.verification` warning. A `china-post.timing`
warning gives each lookup's final phase, puzzle count, OCR time and the times its page,
form, first puzzle and tracking reply arrived. Its two-scan guest window stays marked
incomplete; the helper enters no phone digits and signs into no account.
HuaHan's helper opens no browser: it makes the guest form's own requests and reads the
ordered-character picture with the same worker. Through a request's proxy those requests
leave from a fresh context's request client there, with the helper's own cookies. A reading below its confidence floor is
not submitted; each of at most three pictures opens its own verification session, which
HuaHan counts per address, and a later one opens only while 12 s are left. The widget's refusal returns in the reply's shape, and a
`huahan.verification` warning gives counts and an outcome label, without images or tokens.
JD's domestic single-icon helper matches the prompt's foreground colour pattern,
then independently segments each candidate region to check its shape in the same
rotated pose. Empty rotation padding does not exclude icons near an image edge.
Competing colour matches remain ambiguous even when scene segmentation loses part
of a second icon. Both shape and colour need a margin over other locations.
It declines ambiguous images and layouts outside its supported geometry, and its
`jd.verification` line names which (`geometry`, `image`, `foreground`, `matching` or
`ambiguous`). Its worker has a deadline and concurrency limit; click geometry binds both
displayed images. Readiness and clicks identify the unique image pair inside JD’s
verification modal, so changing inner widget classes does not break the helper.
Its official page retains the original guest session and submits tracking only after
accepted verification. After a visual abstention, the helper may refresh up to three times in the same
session while the remaining lookup budget permits it: the matcher declines puzzles, not waybills, so a
fresh puzzle is a fresh chance. It waits a second after a puzzle appears before refreshing it, since
JD's widget ignores a refresh clicked sooner. Both new images must load and settle before analysis;
worker failures and submitted refusals are not retried. Diagnostics retain only the bounded
attempt reasons and refresh count. Both the request and response bind the whole
waybill. A planned click alone is not accepted verification.
DHL Poland uses TRAWL's native checkbox and audio solver, on a page opened in the language the
request names (`lang=en-gb` or `pl-pl`), which words its scans. While the shared audio pause is
on, it makes a checkbox-only attempt.
Poste Italiane uses that solver only after its tracking API requests a CAPTCHA. Its page
submits the issued token and the helper captures the matching history, keeping the earlier
refusal and excluding verification tokens and recipient fields. A disappearing widget does
not override a tracking request already in flight: its response and body finish within the
same deadline. Failed or unfinished later requests stay failures. While the audio pause below
is on, the helper does not open the page: the adapter asks it only after a direct search drew
the CAPTCHA from the same address, so the page would show it again. The fixed-label
`poste.verification` log records native solver outcomes and pending-request counts without
tokens, parcel identifiers or page text.
Its scoped native modules replace upstream raw debug logs with fixed events.
It submits its history form after reCAPTCHA verification and returns only
the waybill and scan fields, excluding recipient acknowledgements and verification tokens.
Asendia waits for its own Turnstile callback to enable search and binds the captured POST
to one whole identifier. Given a delivery postcode in the fragment, it opens the scans through the page's dialog; otherwise recipient verification leaves the current status only.
Correios Brazil opens its tracker's share link, waits for the page's Turnstile token and searches through
the form, keeping the reply whose POST carried the whole S10 number without locker codes, receipts or
recipient fields. Its `correios.verification` warning counts token receipt, submission and bound
responses with HTTP statuses, without identifiers, tokens or page content. XPO scopes the checkbox
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
TRAWL waits for a page's load event and a quiet network before it asks a capture anything. 17TRACK's
capture ends those waits once the page asks for the number, and Postal Ninja's once its widget shows
the form: both pages keep loading long after their tracker works. Their pages also drop pictures,
fonts, media and the advertising and measurement hosts they load, which no lookup reads; navigations
and Cloudflare's checks always pass, and a Cloudflare wall keeps TRAWL's waits.
UPS binds the browser POST to one tracking ID and retains the latest bounded
response sequence, including refusals after the body extraction budget is spent.
SwiftX's page clears Cloudflare's managed challenge and offers a slider when Turnstile
cannot complete. Its scoped helper matches cutouts, image seams, circular rotations and
ordered icons offline, rejecting ambiguous matches. It uses the page's pointer handlers,
with at most two puzzles; verification tokens stay in that context. It skips the optional
recipient phone dialog, which can come before any puzzle, through the page's Skip control.
The page then posts one GraphQL query; the helper keeps
the decoded reply only for the query naming the whole number in the page's address.
When the address ends in `#trawl-phone-digits=` and four digits, an init script removes that
fragment before the page's scripts run. Once a summary without scans arrives for the number,
the helper types the digits into the summary's own field once and presses its View full
tracking button. It keeps the query that carries those digits as `phoneLast4`, marked
`phoneDigitsSubmitted`, and refuses one with any other digits.

Redis is optional. It stores cookies, user agents and the audio pause deadline with a TTL, not tracking history, and a
cached session that fails falls back to a fresh browser. Do not expose Redis.
A cached session replays in its own fresh context rather than the pool's shared one, and every
tier returns and caches only the cookies of the requested or final page's site, so one carrier's
call never carries another site's cookies. Without a proxy, that context does not count toward
`BROWSER_RECYCLE_AFTER_CONTEXTS`, which is meant for challenge solves: counted, the busiest
carriers' replays replaced each browser every few minutes. The [patch](site-cookies.mjs) stops the
build when TRAWL's code it changes moves.
Keeping a browser session does not make an application CAPTCHA token reusable;
the site can require fresh verification for each action.

## Run it

```sh
docker build -t universal-parcel-scraper-trawl trawl
```

A host that keeps a Dockerfile without its build context, such as Coolify, takes the output of
`node trawl/render-coolify.mjs` instead. It embeds sources while they fit Coolify’s argument
budget; larger builds fetch unchanged files from a pinned public commit and verify their
SHA-256 hashes before installation. Changed files stay embedded. Download or hash failures
stop the build. It labels
the image `org.opencontainers.image.revision` with the commit it was rendered from, followed by
`-dirty` when the sources differ from that commit.

Keep the service on a private network. Pass its URL as `trawlUrl` to the library, or as
`FLARESOLVERR_URL` to the CLI and the HTTP server. `TRACKING_CHROMIUM_PATH` enables the
separate local Chromium transport.

Leave `PROXY_URL` unset: when it is set, TRAWL sends every sessionless `/v1` request through it
with no direct fallback, so a proxy outage fails the adapters that solve pages there. A carrier
that needs a proxy names one in its own request.

`REDIS_URL` configures the session cache. `AUSTRALIA_POST_BROWSER_LOCALE` overrides the
browser locale for Australia Post, `AUSTRALIA_POST_PROXY_FILTER=off` lets its proxied pages load
everything, and `FFMPEG_PATH` selects SF Express's PNG decoder.

`BROWSER_SHUTDOWN_DRAIN_MS` lets accepted lookups finish when the container stops; by default
TRAWL interrupts them. It exits by force 30 seconds after the drain, so give the container a
stop timeout of the drain plus 30 seconds, or the supervisor kills it mid-drain. `GET /metrics`
reports the browser pool to Prometheus.

The image sets `BROWSER_BLOCK_ADS=false`. TRAWL's bundled uBlock Origin compiles its filter lists
in every browser the pool starts and updates them soon after, and page requests wait behind that
work for seconds. Carrier pages weigh the same with or without it. FedEx's browsers, which stay
open between lookups, keep it. `BROWSER_BLOCK_ADS=true` turns it back on.

The pool's browsers move the cursor along a human path at human speed: each mouse move or click
takes most of a second, however short. Helpers give a gesture the page checks one move, and
otherwise use a key or the element's own click handler.

Track123, Correios and China Post load many static files from far away. Their helpers keep them
with `kept-files.mjs` and serve them again in later lookups' fresh contexts, as a browser cache
would. The lifetime comes from the file's cache headers, or a tenth of the time since it changed when they
state none, and is one day at most. Files marked private or uncacheable stay on the network, as do
files that vary by cookie or by a header their request sent.

The image sets `LOG_LEVEL=warn`. TRAWL's request log includes the page path, where some
carriers put the parcel number; `LOG_LEVEL=info` turns that log on. Each tier that fails, is
blocked or times out logs a `tier.failure` warning with the page's host, its status, the page's HTTP status and
the error it caught: the error's name and the first line of its message, up to 200 characters,
without URLs or query strings and with runs that could be identifiers masked.
FedEx's captured API refusals leave the browser tier successful. A separate
`fedex.api-refusal` warning records the API status, browser slot, session reuse,
session age, time since the browser's previous lookup and verified lookup, and
lookup count on that browser. With more than one captured reply, it gives the reply count
and whether the lookup ended accepted. It also times the loaded page, the filled form, the submission
and the first reply, and says whether the cookie banner and the form's menu took a click.
It contains no parcel identifier, response body or cookie. The
`fedex.session-end` warning records why a context closes, its age and lookup count,
and whether a lookup in it was ever verified. It distinguishes expiry and browser
loss from an unreadable or inconclusive reply, without identifiers or response content.

TRAWL drops a reply that reaches its request deadline. The image ends its own waits and
TRAWL's CAPTCHA solvers 2.5 seconds before it, so a page behind an unsolved widget and
the replies already captured are still returned.

TRAWL's reCAPTCHA audio solver stops as soon as Google's challenge frame shows its
automated-traffic page or refuses an answer. It reads both from the frame's class names, so a
widget in any language counts. An automated-traffic page also pauses audio for six hours
across the service's solver copies, Poste Italiane and DHL Poland helpers. Skipped lookups
do not extend the pause; a wrong transcription does not start it. Except on Poste Italiane's
page, which is not opened, clear tracking replies and forms already verified by the page still
work, while unresolved challenges stay available
to enabled provider fallback. With `REDIS_URL`, the pause survives service restarts and rollouts
in the existing Redis store. It keeps only the deadline, shared across solver copies and concurrent
service processes. Without Redis, or while it is unavailable, the pause stays in process memory;
an unavailable store logs a fixed warning. Each store operation is bounded to a quarter second.

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

This derivative is [AGPL-3.0](LICENSE), separate from the core package's licence.
[Matching source and redistribution](SOURCE.md).

Track718 has a Juxi-only helper for its guest detail page. It binds the selected Juxi carrier,
complete number, signed tracking request and WebSocket session, retaining the completed replies
without account or recipient fields. Other Track718 carrier selections use no helper.

## Independent FedEx retry worker

`node trawl/render-fedex-retry.mjs` prints a Dockerfile for a separate container on the
same pinned image, running `fedex-retry-server.mjs` with its own browser pool. `HOST`
defaults to loopback and `PORT` to 8192. Keep its endpoint private and the primary
service's deployment settings. It serves only the exact FedEx capture flow, one lookup per
browser, sharing no browser profile or session with the primary service.
`FEDEX_RETRY_POOL_SIZE` (one unless set, at most eight) is how many browsers it keeps warm;
while every one is serving a lookup it answers 503 with `Retry-After`. The image patches
TRAWL's pool as the primary service's install step does, so a lookup goes to a browser
holding a verified FedEx session, else to the one used least recently.

`FEDEX_RETRY_ROUTE` names the worker's route, `residential` (the default) or `datacenter`,
in its proof, health, metrics and browser pool. `FEDEX_RETRY_PROXY_URL` names one
authenticated gateway, or several separated by white space or commas, such as a list of
datacenter addresses. Each browser context takes the gateway that the fewest live contexts
use, in turn, and keeps it for its life, so lookups running at once leave from different
addresses; a denial never moves a context to another. Each context gets a loopback CONNECT
proxy that sends every tunnel through its gateway, to checked public addresses, without a
direct fallback. A tunnel opens only under the running lookup's lease: the request's `lease` id,
used once, and its `byteAllowance` (at most, and by default, 64 MiB). Each chunk is counted
against the allowance before it is relayed; the one that would pass it is dropped with every
tunnel of the lease. The lease closes when the lookup ends, when its caller goes away, or two
seconds after its budget, and between lookups the proxy refuses every tunnel, so a retained session carries nothing
while idle. The response reports the lease's page and API tunnel counts, tunnel bytes,
allowance and whether it was cut; DNS answers, URLs, cookies, gateways and the rendered page
never leave the worker. Each browser's tunnels open only under the lease of the lookup it
is serving. `/metrics` counts the tunnel bytes, leases by how they ended, refused tunnels
outside a lease, requests taken and those refused while every browser was busy, and gives
the browsers kept and live, the lookups running, the wait for a browser and the container's
memory. Failed contexts and their proxies are closed together. `/health` gives the route,
the number of gateways and the browsers kept. Run one worker per route and use
`FEDEX_RESIDENTIAL_TRAWL_URL` and `FEDEX_DATACENTER_TRAWL_URL` in the consumer, as the
[FedEx adapter](../carriers/fedex/README.md) describes.

A gateway that refuses tunnels, as when its pinned exit goes offline, makes every lookup
fail after its deadline. The `fedex.gateway-refusal` warning counts a lookup's refused
tunnels, those for the page and API among them, and gives the gateway's last status and
the plain-token reason it names in an `x-…-reason` header, such as Webshare's
`x-webshare-reason`.

With `FEDEX_WARMUP_NUMBER` set to a public FedEx sample and `FEDEX_WARMUP_PEER` to the
worker's network alias, a new worker prepares a verified FedEx session before it opens its
port while another worker under that alias answers its health check, as TRAWL does for USPS.
FedEx usually refuses a new session, so without this a fresh worker's first lookups fail. It
looks the number up as the adapter would, at most five times and within two and a half
minutes, and listens once FedEx accepts one, when the attempts are spent, or as soon as the
other worker stops answering. A worker started alone opens its port at once and makes the
same lookups between its callers' own. Each lookup spends proxy bytes under its own lease.
Give the health check room for the wait (start period plus retries times interval above
three minutes). A `fedex.warmup` warning records whether the port was held, how the wait
ended, the lookups made and the duration.

On SIGTERM the worker closes its port, so callers connect to the worker replacing it, and
lets the lookups already running finish, up to 45 seconds, before it closes their tunnels and
its browsers. Give it a stop grace period above that.

J&T Brazil opens a fresh number-only guest form and solves its supported Tencent jigsaw in
the page. The match requires texture and shape agreement, stable native-image geometry and
a measured slider movement. A refreshed challenge cancels the held drag. The helper keeps
verification and tracking separate, waits for the page callback after the widget disappears,
and captures only the matching whole-waybill POST. It enters no CPF/CNPJ or account/POD
flow, and retains no images, tokens, remarks, staff or recipient fields.

Flash Courier uses a scoped anonymous HTTP helper with the local CPU OCR environment. It binds the official form and returned shipment to the whole reference, caps fresh images and submissions separately, keeps cookies and answers in memory, and ends the subprocess within the caller budget. No browser context is opened for this route.

Correos de Costa Rica uses its current guest form in a fresh context. The form owns the
CSRF session and reCAPTCHA answer. The helper binds the whole main-frame POST and its
redirected result document, then returns only the shipment identity and movement rows.
Signer details, cookies, verification fields and page HTML stay in the context. An audio
pause leaves one checkbox-only attempt; an unfinished verification keeps provider fallback.

PasarEX ticks its tracking form's reCAPTCHA checkbox in a fresh context and sends the form's
own GET. Pictures the checkbox asks for go to the picture solver below, with up to 55 seconds:
Google can ask for several challenges in a row, and refuses the service's audio for hours at a time
while the pictures still pass. Audio comes last, outside the audio pause and only when the pictures
leave 15 seconds. The helper binds that one main-frame request to the whole number and returns the
order's number and its status groups of rows. The token, cookies and page HTML stay in the context.

The reCAPTCHA picture solver finds the challenge's target with YOLOX-M, an object detector
trained on COCO, run locally on the tiles of a screenshot of the challenge. It covers the targets
COCO names (bicycles, buses, cars, motorcycles, boats, traffic lights, fire hydrants, parking
meters) by the English words of the instruction, and takes a new challenge for any other target
or language. A whole picture split into squares takes the squares a detected box covers; a tile
that fades out is checked again once its new picture shows. A grid of separate pictures always
shows the target, and Google refuses an answer that finds none there, so the solver takes a new
challenge instead. It plays at most eight challenges and four waves of new tiles per lookup, within
the time given, and stops on Google's block. Each detection runs in a worker of its own, at most two
at once, and keeps no picture. It logs only its outcome, counts and target class
(`pasarex.recaptcha_images`). The model and its license are fetched by checksum when the image is
built.

Biman's waybills go through CHAMP's freight.aero tracker. The helper picks the airline its
prefix names in the page's own list, enters the serial and asks; the page then shows its
reCAPTCHA checkbox, which the helper ticks or, outside the audio pause, solves by audio. Once it
calls back, the page posts the lookup, and only that main-frame POST for the one whole waybill and
airline goes out, once. The helper returns each waybill's route, status and dated events,
without weights; the token, cookies and page HTML stay in the context.

Kuwait Post's tracker on moc.gov.kw sends its form to a Next.js server action. The helper waits
for the page's reCAPTCHA checkbox, enters the item code, ticks the checkbox or, outside the audio
pause, solves it by audio, and sends the form. Only that main-frame POST, with the whole code and
one token, goes out, once. The reply does not repeat the code. The helper returns its outcome and
each scan's country, event, wall clock, office and non-delivery details; the signatory, next
office, token, cookies and page HTML stay in the context.

moc.gov.kw sends its certificate without the DigiCert intermediate that signs it, and Firefox
does not fetch a missing intermediate, so the browser cannot open the site itself. The helper
relays the site's own requests over Node's TLS with the system roots and that intermediate,
which it bundles; reCAPTCHA and other hosts load directly. The relay keeps the page's cookies,
refuses redirects and images, and caps each response.
