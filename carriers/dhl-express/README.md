# DHL Express

DHL Express waybills through MyDHL+ and DHL's public tracking portal, separate from
the German DHL Paket adapter.

Detection shares the [MyDHL+ tracking page](https://mydhl.express.dhl/gb/en/tracking.html)'s
waybill check with the adapter. A passing check prioritizes a candidate; it does
not confirm the carrier or the existence of a shipment.

## Retrieval

`direct` asks the public `shipmentTracking` JSON endpoint for one waybill.
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

## Mobile API lead

The [official Android app](https://play.google.com/store/apps/details?id=com.dhl.exp.dhlmobile)
has package id `com.dhl.exp.dhlmobile`; DHL publishes its signing fingerprints in
[assetlinks.json](https://dhle.dhl.com/.well-known/assetlinks.json).
Its hybrid UI uses native pinned HTTP for tracking. The adapter does not use
this route.

Guest tracking posts to `https://dhle.dhl.com/access/access/com.dhl.exp.dhlmobile`
with query parameters `appVersion` and `service=shipments-tracking`, and a JSON
body naming `service: "shipments"` and `method: "tracking"`. The data includes
`airWayBill`, `countryCode`, `languageCd`, `addShipmentToODD`, `moreDetails`, `iv`
and device metadata. Guest reads use empty user credentials but still require
the app's application bearer credential; missing application authentication
returns 401. The body includes an `authentication` object with provider
`DEMP.RS1` and empty `token` and `login` fields. Keep credentials outside Git.

The app reads `countrySettingsBySettingName` under the `common` service;
`api_awb_encryption` controls waybill encryption. The tracking flow also supports
`captchaVerificationData`. Returned shipments use `id` and `checkpoints`, with
localized `date`/`date_en` and `time` fields. Summary status can be empty despite
usable scans, so evaluate each event and preserve facility-local clocks. Match
the whole waybill and compare milestones before adopting this alternative.

## Limits

The returned identity must match the whole waybill and the browser response must
identify the Express division. Reused waybills and empty histories stay inconclusive.
MyDHL+ facility clocks are preserved without invented offsets; the global portal's
explicit offsets provide dated instants. Recipient details, piece identifiers and
proof-of-delivery links are discarded. A blocked HTTP request requires a configured
browser service with the DHL Express capture helper.

## Testing

`npm run test:carriers:live -- carriers/dhl-express`

Set `DHL_EXPRESS_LIVE_TRACKING_NUMBER` and `TRAWL_URL` to exercise browser retrieval.
Carrier protection can reject HTTP and browser sessions. These failures stay
distinct from a missing waybill.
