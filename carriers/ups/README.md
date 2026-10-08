# UPS

Global UPS tracking from the site's own `GetStatus` JSON, read through a browser because
Akamai blocks plain HTTP. Parcels handed to a national post for the last mile are still
reported from the UPS record.

## How it works

The adapter accepts only `1Z` numbers and rejects anything else before any request.
Detection selects UPS only when the last digit matches the check digit over the 15
characters after `1Z` (a letter counts as its ASCII code minus 63, mod 10; weights 1, 2
from the left); a mismatch stays a suggestion.

1. `trawl` (whenever a browser service is configured): loads
   `https://www.ups.com/track?loc=en_US&tracknum=…&requester=ST/trackdetails` with
   `captureResponses` on `POST https://webapis.ups.com/track/api/Track/GetStatus?loc=en_US`
   and parses the reply the page itself received. If nothing readable was captured, it parses
   the rendered page instead: current status and, once delivered, where, with no history.
   Its ship-to town is the recipient's, never the banner's place.
2. `direct` (only without a browser service): plain HTTP with an in-memory cookie jar.
   - Fetch the tracking page, check it set the `X-XSRF-TOKEN-ST` cookie, then POST
     `GetStatus` with that value as the `X-XSRF-TOKEN` header. Cache the session.
   - A cached session that gets rejected fetches the page once and retries; a second
     rejection drops it.
   - If the API call fails, the fetched page is parsed as a rendered page. Otherwise it fails
     with `ChallengeError('UPS challenged direct tracking; configure FLARESOLVERR_URL for
     browser fallback')`.

In practice Akamai holds `GetStatus` open until the timeout (20 s direct) for any session a
browser did not establish. A deployment without a browser service therefore gets only the
rendered status, after that wait.

## Notes

- Lookups are serialized per adapter instance: the jar and XSRF token are shared, and two
  concurrent refreshes produce a session that belongs to neither.
- HTTP 401/403/419/429, or a page with no token, raise `UPSSessionRejected` (a
  `ChallengeError`), which the refresh-once logic reacts to. Any other HTTP error, including
  404, is indeterminate: it proves nothing about the parcel and must not start a not-found
  cooldown.
- `direct` is disabled whenever a browser exists, with no cooldown probe: every probe costs
  the full direct timeout and hits the same block.
- Each scan's `actCode` is kept as `provider_code` and mapped to a stage
  ([statuses.json](statuses.json)). One wording can cover two codes: `OR` and `AR` both read
  "Arrived at Facility". An unmapped code gets no stage; the sync classifies its wording.
- The newest scan's code sets the current stage and status. `progressBarType`, then the
  prose, decide only when that code is unmapped. The token reads `Exception` for a mere delay.
- `pickup_point` names the access point only while the newest scan is `2Q` or `ZP`. Replies
  can carry an access point the parcel never reached. It is the business name, then the
  street and the town on their own lines when `upsAccessPoint.location` gives both, as the
  tracking page shows them. The attention name is never read: it can name a person.
- `delivered_at` is the delivering scan's time; `destination_country` the ship-to or delivery
  country code.
- Prose arrives HTML-escaped (`We&#39;re`, `&#174;`) and is decoded.
- A 402 "Invalid Request" for a number whose check digit fails is `InvalidInputError`, from
  either step. Other refusals stay indeterminate.
- The app scan-identity policy updates a scan when UPS adds its location, provided its
  exact instant, wording and known stage agree. Conflicting locations and distinct
  messages at one instant remain separate.
- The rendered-page parser reads only the active progress-bar milestone. Reading the whole
  bar classified label-created parcels as out for delivery. The banner's one event has no
  code; "Label Created", "On the Way", "Out for Delivery" and "Delivered" get their stage from
  the map, other banners none. Scan wording is never read without its code.
- Scan times are built from the UTC pair UPS sends, or the local pair plus its explicit
  offset. A local pair without an offset stays `local_time` and other text
  `provider_time_text`; no zone is guessed. Some label scans come with no clock and get none.
- The scheduled delivery date has no year. The adapter picks the year that puts it within
  the last week or in the future.
- The canary URL is a static PDF so the canary itself is not challenged.

## Mobile API lead

The official [UPS APK](https://play.google.com/store/apps/details?id=com.ups.mobile.android)
delegates tracking to native code despite also containing a React Native bundle.
Its detail read is `POST https://onlinetools.ups.com/api/molws/v2/tracking/details/{number}`
with locale, an empty nickname body and a bearer token. Set both
`AddPackageToTrackHistory` and `GetNicknameFromTrackHistory` to false for an
independent lookup. The separate `TrackHistory` methods modify saved tracking
records; they are not the parcel's scan feed.

Guest tokens use `/security/v1/distributed-apps/authorize` and `/token` with
`audience: anonymous` and a code challenge/verifier. The request builder also
sends version and `X-Firebase-AppCheck` headers. Plain HTTP guest authorization
is rejected with 401; the presence of the App Check header alone does not establish
whether attestation is enforced. This route needs a verified guest session before
it can replace browser retrieval. Application configuration and tokens stay outside Git.

## Rejected approaches

- Calling `GetStatus` without loading the page first: 401 without the page's cookies.
- Replaying the browser's cookies over plain HTTP: Akamai holds that call open too, from
  datacenter and residential IPs alike.
- Parsing the rendered page as the primary path: it has no history.

## Limitations

- No delivery window or dimensions. The weight field comes back empty.
- No sender name: `senderShipperNumber` is the shipper's account number.
- The service name (`UPS Ground Saver®`) is in the reply, but the result has no field for it.
- Without a browser service there is no history.
- The ship-to address beyond its country, the signatory, the proof-of-delivery link and the
  access point's attention name, hours and coordinates are in the reply but never kept; a
  test asserts it.

## Testing

No dedicated live test. The wrong-number canary in
[`testing/browserProtectedCarriers.live.test.ts`](../../testing/browserProtectedCarriers.live.test.ts)
accepts either a clean no-result or the exact challenge error above:
`npm run test:carriers:live -- testing/browserProtectedCarriers.live.test.ts`.
