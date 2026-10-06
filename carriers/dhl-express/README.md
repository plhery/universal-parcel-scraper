# DHL Express

DHL Express waybills through its mobile guest API and public tracking portal, separate from
the German DHL Paket adapter.

Detection shares the [MyDHL+ tracking page](https://mydhl.express.dhl/gb/en/tracking.html)'s
waybill check with the adapter. A passing check prioritizes a candidate; it does
not confirm the carrier or the existence of a shipment.

## Retrieval

`direct` asks the mobile guest API for one waybill. It checks the application's
current waybill-encryption setting before tracking, so a configuration or
authentication failure cannot look like a missing shipment. The shared
application bearer is included; consumers need no DHL account or key setup.
After an HTTP challenge or transport failure, `trawl` loads DHL's global tracking
page in a fresh context and captures its matching `utapi` response. The browser
lets the page complete its verification and repeat tracking after an HTTP 428;
the intermediate challenge is not a shipment answer. HTTP recognition never
launches a browser; browser recognition is a separate opt-in phase and retains
its history.

The global portal's SEC-CPT flow runs its own JavaScript proof of work before
retrying `utapi`. Observe that exchange in the scoped browser helper before
changing headers or reproducing challenge code. MyDHL+ can instead return a
blocked HTML page with HTTP 200; that page contains no usable tracking history.

The [registered Shipment Tracking Unified API](https://developer.dhl.com/tracking)
is another route, separate from the public portal. It requires a consumer-owned
subscription key in `DHL-API-Key`; its demo key and Try Now responses are mocked
and cannot establish live tracking coverage.

## Mobile API

The [official Android app](https://play.google.com/store/apps/details?id=com.dhl.exp.dhlmobile)
has package id `com.dhl.exp.dhlmobile`; DHL publishes its signing fingerprints in
[assetlinks.json](https://dhle.dhl.com/.well-known/assetlinks.json).
Its hybrid UI uses native pinned HTTP for tracking.

Guest tracking posts to `https://dhle.dhl.com/access/access/com.dhl.exp.dhlmobile`
with query parameters `appVersion` and `service=shipments-tracking`, and a JSON
body naming `service: "shipments"` and `method: "tracking"`. The data includes
`airWayBill`, `countryCode`, `languageCd`, `addShipmentToODD`, `moreDetails`, `iv`
and device metadata. Guest reads use empty user credentials but still require
the app's application bearer credential; missing application authentication
returns 401. The body includes an `authentication` object with provider
`DEMP.RS1` and empty `token` and `login` fields. `addShipmentToODD` stays disabled
so tracking does not save a shipment to an account.

The app reads `countrySettingsBySettingName` under the `common` service;
`api_awb_encryption` controls waybill encryption. The tracking flow also supports
`captchaVerificationData`. Returned shipments use `id` and `checkpoints`, with
localized `date`/`date_en` and `time` fields. Summary status can be empty despite
usable scans, so the adapter derives status from checkpoints ordered by their
counter and uses `date_en` for English facility-local clocks. An encryption
requirement or CAPTCHA stays a challenge and can recover through the browser.
The mobile API can report its CAPTCHA code inside HTTP 503; that explicit code
is verification evidence rather than a maintenance or missing-shipment answer.

## Limits

The returned identity must match the whole waybill and the browser response must
identify the Express division. Reused waybills and empty histories stay inconclusive.
A mobile scan carries its facility's clock and its location, without an offset. The
location reads `CITY - COUNTRY`, or `CITY - REGION - COUNTRY` in the USA and Canada, where
the region is a state's or province's name or code. [clock.ts](clock.ts) reads the clock in
the country's zone when the country keeps one civil time, and in the majority zone of the
state or province, so a facility in its other zone is an hour off. Spain and Portugal file
their islands under the country: a town or island of the Canary Islands or the Azores takes
the islands' clock, unless the mainland has a town of that name. Ship24 relays the same
scans with DHL's own offsets, and the rule agrees with them on every scan of the public
samples.

A scan whose location settles no zone keeps its clock as `local_time`: a country with
several clocks and no region, or a country DHL writes in a form the rule does not know.
The rule knows English country names and the forms seen on DHL's scans (`UK`, `USA`,
`NETHERLANDS, THE`). The global portal's explicit offsets provide dated instants. Recipient details, piece identifiers and
proof-of-delivery links are discarded. A blocked HTTP request requires a configured
browser service with the DHL Express capture helper.

## Testing

`npm run test:carriers:live -- carriers/dhl-express`

Set `DHL_EXPRESS_LIVE_TRACKING_NUMBER` to exercise mobile retrieval. Add `TRAWL_URL`
to exercise the separate browser path.
Carrier protection can reject HTTP and browser sessions. These failures stay
distinct from a missing waybill.
