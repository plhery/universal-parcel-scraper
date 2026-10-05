# USPS

United States Postal Service tracking from the server-rendered tracking page, loaded in a
browser because Akamai blocks plain HTTP. Also covers incoming international mail that keeps
its original S10 number when USPS delivers it.

## How it works

The adapter accepts 20- or 22-digit labels and checksum-valid UPU S10 numbers with any
country suffix, and rejects anything else before any request. Without a browser service it
fails at once with `ChallengeError('USPS challenged direct tracking; configure
FLARESOLVERR_URL for browser fallback')`.

1. `trawl`: the browser service loads
   `https://tools.usps.com/go/TrackConfirmAction?tLabels=…`, runs the interstitial check, and
   the rendered DOM is parsed. There is no tracking XHR to capture: the page carries its data
   as HTML.

Parsing, in order:

- No `.track-bar-container`: `ChallengeError`. A browser can get HTTP 200 containing only a
  JavaScript challenge.
- `#trackingNum` echoes another number: `SchemaError`. The full number, S10 suffix
  included, must match.
- "Tracking Not Available" in `.latest-update-banner-wrapper .banner-header` (unknown or
  expired number): unlocated `unknown`. Only that wrapper counts; `.banner-header` is also
  used by an upsell banner.
- History comes from `.tb-step` cards (`.tb-status-detail`, `.tb-date`, `.tb-location`).
  Collapsed cards already hold the full history in the HTML. Undated placeholder steps and
  the "See All Tracking History" control are skipped. Rows of the older
  `.tracking_history_container` table are a fallback.

## Notes

- Accepting a foreign S10 number does not make detection pick USPS. The S10 suffix names
  the issuing country, not the destination; callers select USPS or go through the
  delivery-partner handoff route.
- Scan times are facility-local. The state in the location maps to a zone (multi-zone states
  use their majority zone). With no resolvable state the event keeps an offset-free
  `local_time`, or `raw_time` for date-only text, and the page's newest-first order is kept
  rather than re-sorted.
- Delivered lines are rewritten to "Delivered" because USPS names the signatory.
- "Available for Pickup" and "Arrived at Post Office" are stage `ready_for_pickup` but result
  status `out_for_delivery`.
- There is no direct step: it would only burn the budget on a 403.

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
This is an option for consumers with those credentials; it cannot provide an
anonymous default. Developer authentication is not integrated into this adapter.

## Rejected approaches

- Plain HTTP to the tracking page, with or without cookies: 403 before any content.

## Limitations

- Browser access is intermittent: some sessions get only the challenge. That surfaces as
  `ChallengeError` so the router can fall back to universal providers.
- The public page shows city/state/ZIP only; no recipient, signature or photo is read.

## Testing

`npm run test:carriers:live -- carriers/usps` with
`USPS_LIVE_TRACKING_NUMBER` and `FLARESOLVERR_URL` set. The missing-browser check runs
without either.
