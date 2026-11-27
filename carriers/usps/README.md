# USPS

United States Postal Service tracking from the server-rendered tracking page, loaded in a
browser because Akamai blocks plain HTTP. Also covers incoming international mail that keeps
its original S10 number when USPS delivers it.

## How it works

The adapter accepts 20- or 22-digit labels, checksum-valid 26-digit IMpb identifiers,
and checksum-valid UPU S10 numbers with any country suffix. Scanned IMpb barcodes
may include a five- or nine-digit routing ZIP after `420`; the adapter strips only
a uniquely valid routing prefix before querying and checking response identity, and
reports the package identifier as `canonical_tracking_number` so a consumer can keep
the number without the recipient's ZIP code. When both readings of a 34-digit barcode
pass the check digit, the one whose Mailer ID fits its channel is kept; when both or
neither fit, the barcode is rejected.
[Publication 199](https://postalpro.usps.com/pub199) defines that structure and
the PIC checksum and its channel identifiers: `92` to `94`, plus retail `95` and the
legacy `91` on 22-digit PICs.
A 22-digit PIC selects USPS when its check digit passes and its Mailer ID fits the
channel: nine digits starting with 9 for `92` and the legacy `91`, six digits
starting with 0 to 8 for `93`. A 26-digit PIC on channel `92` selects USPS by the
same test; one on `93` stays a suggestion. Austrian Post and Estafeta also issue 22-digit
numbers, but none known starts with a USPS channel. DHL eCommerce tracks the `9261`
and `9361` families as well, so those stay suggestions. A routing barcode selects USPS
when its PIC would, unless a ZIP+4 add-on starting with 92 to 94 could also open a
26-digit PIC. Other matching IMpb rules prioritize USPS as a candidate. None of them
establish shipment existence.
Opt-in browser recognition reuses the lookup
and requires dated activity. Anything else is rejected before a request. With neither browser it
fails at once with `ChallengeError('USPS challenged direct tracking; configure
FLARESOLVERR_URL for browser fallback')`.

1. `browser`, with `USPS_BROWSER_WS_ENDPOINT`: a private Google Chrome that has a window, on a
   residential connection, loads the tracking page. USPS's verification accepts that browser
   and leaves headless Chrome, Chromium and the browser service's Firefox on a blank wrapper,
   from a residential address as from a server's. A new context's first navigation gets the
   wrapper, whose script earns the session; the page is asked again two seconds later and loads
   tracking. The accepted session's USPS cookies are kept in memory and given to the next
   lookup's context, which then loads tracking at once: about five seconds for a new session,
   under two after it. A kept session that gets the wrapper or the outage page is forgotten.
   Pictures, fonts and video are not loaded, a third of the page's bytes; Akamai's own requests
   are. The endpoint is a [private browser worker](../royal-mail/README.md) started with
   `ROYAL_MAIL_BROWSER_HEADED=1`. With a browser service too, this step has twenty seconds, and
   a wrapper, an outage redirect, an unavailable worker or that time running out hands the
   lookup to `trawl`. USPS also turns new sessions away on every address for hours at a time,
   this browser's included, which then spends about fifteen seconds on the wrapper; in some
   spells it refuses one read in three. Once two lookups within fifteen minutes end on it,
   lookups read through `trawl` first and through this browser only when `trawl` fails or is
   paused, so the wait goes only where it can still help. The rest lasts fifteen minutes; the
   next lookup then asks this browser first again, and a wrapper within fifteen minutes of the
   rest's end starts one twice as long, up to an hour. A page this browser loads during a rest
   ends it. In such a spell `trawl` fails nearly every lookup and this browser loads few of
   them, so during a rest it reads one lookup `trawl` failed every five minutes at most, and the
   others end with `trawl`'s failure within seconds. When USPS lets none of the browser
   service's sessions through, for days at a time, `trawl` answers that it has no session ready
   and reads nothing, while this browser's refusals pass within minutes; it then reads one of
   those lookups a minute. A host that keeps adapters' holds keeps the rest across restarts.
2. `trawl`: the browser service loads
   `https://tools.usps.com/tracking/…`, runs the interstitial check, and
   waits for the visible tracking number before the rendered DOM is parsed. The verification
   page can finish loading before it reloads into tracking, so network idleness alone is
   insufficient. There is no tracking XHR to capture: the page carries its data
   as HTML.

The verification wrapper can stay blank when its tracking request redirects to
USPS's service outage page. The service captures that exact redirect. USPS sends the first
read of every browser session there and lets only some sessions through, so the service
prepares sessions in the background and reads USPS only through ones it has let through
([TRAWL's README](../../trawl/README.md)). A lookup that finds none ready reads nothing and ends
as indeterminate. A redirect concerns one
read, but redirects come in runs that do not follow how often we read: a read straight
after one redirect usually loads, one after two about half the time, and after three in a
row the next read is redirected more often than not, whether it comes seconds or minutes
later. So a lookup reads up to three times while it is redirected, and once three reads in
a row through one browser service are redirected, its reads pause for five minutes. The
pause spares reads rather than waiting a spell out: twenty minutes on, the next read fares
about as it does five minutes on. A lookup during the pause reads nothing and ends as the
adapter's own pacing, `rate_limited` with `self_paced` and the wait, so a consumer can
hold its checks until the pause ends rather than count a failure of USPS. The first read after the pause
pauses them again if it is redirected; a page that loads ends the run, and reads go on at
the consumer's own rate. A lookup whose every read is redirected ends as temporary
unavailability. An unresolved verification page remains a challenge; a complete matching
history takes precedence over an earlier outage reply.

USPS turns some server addresses away for hours while others load. With
`USPS_DATACENTER_PROXY_URL` or `USPS_FALLBACK_PROXY_URL` set to an HTTP(S) proxy, other lookups read
through a proxy while the service's own reads are paused: the datacenter one first, and the fallback
one, such as a residential connection, once the datacenter one rests too. Besides three redirects in a
row, the service answering that it holds no session USPS let through on its own address pauses
them for five minutes, and that lookup is read again at once through a proxy, then through the
fallback one if the datacenter one has no session either. The browser service carries the whole
context through the proxy, in sessions it prepares there, and never falls back to its own address.
Outside a pause no proxy carries anything. A refusal of the service's address leaves the proxies'
sessions loading tracking; USPS's own outage sends all of them to its outage page. A lookup that met
the outage page is never read again through a proxy: USPS's outage pages follow its own hours, and
reads through a proxy met them too. Once USPS sends a read through a proxy to its outage page, or the
service has no session there, that proxy rests until the own route's pause ends; with no proxy left,
lookups until then end as `self_paced`. Each read's step record names its route, `default`,
`datacenter` or `residential`, without the proxy's address.

The fallback proxy is paid by the byte and shared with other carriers. A tracking read through a
proxy measures about 2 MB, a redirected one about 0.6 MB, whether or not images, fonts and styles
load, and the service's session trials come on top. So a read through it is charged 4 MB against a
daily share, `USPS_FALLBACK_PROXY_DAILY_BYTES`, 60 MB by default. The share refills continuously,
holds at most a quarter of a day's share and starts with one read. While it is spent, lookups the
datacenter proxy cannot read wait as during a pause.

A host that keeps adapters' holds (`keepAdapterHolds`, see [ARCHITECTURE.md](../../ARCHITECTURE.md))
keeps both pauses across restarts.

USPS sends no rate limit of its own: a lookup that ends as `rate_limited` is the outage pause,
`self_paced`, and sent nothing. Each lookup opens a browser, and checking followed parcels every
ten minutes kept the pause coming back for hours. The catalog asks for a refresh at most every
half hour, and an hour after a failed one, out for delivery included.

Parsing, in order:

- No `.track-bar-container`: `ChallengeError`. A browser can get HTTP 200 containing only a
  JavaScript challenge.
- `#trackingNum` echoes another number: `SchemaError`. The full number, S10 suffix
  included, must match.
- "Tracking Not Available" in `.latest-update-banner-wrapper .banner-header` (unknown or
  expired number): unlocated `unknown`. Only that wrapper counts; `.banner-header` is also
  used by an upsell banner and by the headings of the estimate's tooltips, which are skipped.
- The estimate comes from `.expected_delivery`, whose weekday, date, month and year sit in
  elements of their own ("Wednesday 28 October 2026 by 9:00pm"), and becomes
  `expected_delivery` as a calendar day, or a slot when it gives a window. A newest
  out-for-delivery scan's "Expected Delivery Between 1:15pm and 4:15pm" is a slot on that
  scan's day, unless the banner names another day. A delivered parcel has none. The page
  alternates between "In Transit, Arriving On Time" and, between scans, "In Transit to Next
  Facility", whose banner keeps the day first expected after the other version has moved it:
  that banner's day is not read, and a consumer keeps the day the other version gave.
- History comes from `.tb-step` cards (`.tb-status-detail`, `.tb-date`, `.tb-location`).
  Collapsed cards already hold the full history in the HTML. Undated placeholder steps and
  the "See All Tracking History" control are skipped. Rows of the older
  `.tracking_history_container` table are a fallback.

## Notes

- Detection names USPS for the parcels, EMS, registered and tracked-letter items it
  issues: `C`, `E`, `L` or `R` first, `US` last and a passing check digit. Its tracker
  follows them abroad, and USPS has no HTTP lookup, so recognition could not find it
  for them before a check. `CV` and `CE` codes are left out: Meest's tracker follows
  parcels from the United States under `CV` codes, and a CDEK Forward parcel from the
  United States was given a `CE` code. Other `US` codes stay with the unknown postal
  carrier, which makes USPS a candidate for opt-in browser recognition only. Other
  suffixes reach USPS when callers select it or through the delivery-partner handoff
  route.
- Scan times are facility-local. The state in the location maps to a zone (multi-zone states
  use their majority zone, except in a town of a part with its own clock: Florida's Panhandle
  keeps Central time); a facility without a comma names its state before its kind, as in
  `EXAMPLE CITY NY DISTRIBUTION CENTER`, `EXAMPLE CITY PA PACKAGE SORTING CENTER` or
  `EXAMPLE CITY LA PROCESSING CENTER`. A place
  that gives only a ZIP code is in that ZIP code's state, by its three-digit prefix. With no
  resolvable state the event keeps an offset-free `local_time`, and the page's newest-first
  order is kept rather than re-sorted. USPS writes its international service centre at JFK as
  "JAMAICA" alone; the [place reader](../../places/README.md) puts it in Jamaica, New York,
  unless the parcel goes to Jamaica. A scan abroad names its country, the United Kingdom by
  its official name, and is read on that country's clock. A step USPS dates by its day
  alone, as it does pre-shipment info, keeps that day as `local_time`.
- USPS enters some departures at their scheduled time, before they happen. A scan dated more
  than five minutes after the lookup is held back until it is due (`plannedScans`).
- A label row, such as "Shipping Label Created", "Shipping Label Created, USPS Awaiting Item"
  or a merchant's "Merchant Order Receipt Notification", is mostly on the facility's clock:
  DHL eCommerce, 4PX and Yanwen date the mailer's own label at its digits on that clock, to the
  second. Some mailers write it on UTC, so a label row is read on UTC when the facility's zone
  dates it after the lookup and UTC does not. Once both date it in the past, nothing tells them
  apart and it keeps the facility's zone; its row takes over the stored one by its wall clock.
  ParcelsApp's, 17TRACK's and Postal Ninja's copies are read the same way.
- Delivered lines are rewritten to "Delivered" because USPS names the signatory.
- Incoming international mail shows "Origin Post is Preparing Shipment", undated, from the
  origin post's electronic notice until USPS scans the item, past the origin post's later
  scans abroad and sometimes after the item arrives. While a scan is dated, the newest
  scan's wording is the status instead.
- USPS rewords scans it already shows: an out-for-delivery scan's delivery window changes,
  and the newest place-less step's "In Transit, Arriving On Time" reads "In Transit to Next
  Facility" once a later step comes. The identity policy lets such a scan take over the row
  stored in its earlier wording at its instant and place, and a place-less scan the row
  showing its wall clock under another deduced zone. A step reworded and re-zoned between
  two reads matches neither way.
- The reminder to book a redelivery, days after a missed delivery, is a notice: it keeps the
  stage of the scan before it with no source of its own.
- "Available for Pickup" and a hold at the post office are stage `ready_for_pickup` but result
  status `out_for_delivery`. "Arrived at Post Office" is the delivering office's arrival before
  the delivery round, so it stays `in_transit`.
- A parcel a shipping partner collects and moves reaches USPS with an acceptance scan such as
  "USPS in possession of item". After the partner's transit scans that handoff is
  `in_transit`, as is the parcel's stage; only an acceptance before any transit stays one.
  The partner's own scans are `accepted` for its pickup and `in_transit` for its facilities'
  arrivals and departures, also when USPS adds ", USPS Awaiting Item": that only says USPS has
  not received the item yet, so they are no label, and their clock is the place's.
- A return starts with "Return to Sender" or "Refused". From that scan the history is the trip
  back (`provider_leg` `return`): its movements and its delivery to the sender are `returned`, as
  is the parcel's stage while the newest scan is on that trip. USPS keeps naming them "Arrived at
  USPS Facility" and the like, so without this the parcel would read as in transit to the
  recipient again. The status map declares this (`returnTrip`), so a universal provider's copy
  of a USPS history reads its return the same way.
- There is no direct step: it would only burn the budget on a 403.
- The package path is loaded directly because the legacy query route can return only
  the global header. A recognizable header-only reply, or the tracking page's head
  captured before its body, gets one more browser read within the same budget;
  telemetry retains the first failure. The bot check's blank interstitial, an untitled
  page holding only its script, which the browser can capture before the script reloads
  into the tracking page, gets up to two more: a second read stays on it about as often as
  a first one. A read redirected to the outage page gets up to two more. Other challenges,
  identity errors and rate limits are not repeated. Pasted legacy query links remain
  supported.

## Mobile API leads

The official [USPS Mobile APK](https://play.google.com/store/apps/details?id=com.usps.app)
opens `https://m.usps.com/m/TrackConfirmAction` in a WebView. Its native bridge
handles scanning and saved labels; it does not provide a separate tracking read.
The hosted destination returns a generic 404, which cannot establish parcel absence.

The newer [Informed Delivery APK](https://play.google.com/store/apps/details?id=com.usps.id45833)
contains the `https://apis.usps.com/tracking/v3` API base and native tracking models.
Its account token flow uses authorization codes with PKCE and the `tracking`
scope through `https://keyc.usps.com/realms/USPS-M/protocol/openid-connect/token`.
Obtaining the token requires user sign-in; the APK's client identifier is not an
access token. The tracking API rejects requests without a token with 401, which
does not establish how an authenticated tracking request behaves. This account
flow is not integrated into the adapter. Informed Delivery's household mail,
images and subscriber endpoints are outside this adapter's scope.

The separate [official developer API](https://github.com/USPS/api-examples/blob/main/README.md)
uses `client_credentials` at `https://apis.usps.com/oauth2/v3/token`, with a
registered application's Consumer Key and Consumer Secret and tracking access.
[USPS's access rules](https://www.usps.com/business/api-access.htm) give tracking data
free to a shipper for its own Mailer ID and to a platform a shipper authorizes. Anyone
else, such as a tracker for parcels it did not ship, needs paid access: a monthly fee, a
signed intellectual property agreement and authorization for the Mailer ID or the
tracking number. The [API terms](https://developers.usps.com/node/3) limit use to
facilitating USPS shipping or mailing transactions and set request limits USPS may
change. This is an option for consumers with that access; it cannot provide an
anonymous default. Developer authentication is not integrated into this adapter.

## Rejected approaches

- Plain HTTP to the tracking page, with or without cookies: 403 before any content.

## Limitations

- Browser access is intermittent: some sessions get only the challenge. That surfaces as
  `ChallengeError` so the router can fall back to universal providers.
- USPS judges the browser session more than the browser or its address: a new session's first
  read goes to the outage page, headed or headless, Chromium or Camoufox, and only some sessions
  are let through after that, and one let through can be turned away again. Until the service
  holds one, universal providers answer. Webshare's
  proxies refuse tunnels to USPS.
- The public page shows city/state/ZIP only; no recipient, signature or photo is read.

## Testing

`npm run test:carriers:live -- carriers/usps` with
`USPS_LIVE_TRACKING_NUMBER` and `FLARESOLVERR_URL` set. The missing-browser check runs
without either.
