# Mondial Relay

French parcel-shop network (last mile in FR, BE, ES, LU, PT). Tracked through
the French recipient website in a real browser, because Cloudflare blocks
direct requests to that flow.

## How it works

1. `trawl` (the only step): two requests through the browser service, on one
   solved identity.
   - Load `/suivi-de-colis/` and read the `token` attribute of `#tracking` from
     the captured response body (`trawlBody()`), not the rendered HTML: the Vue
     app replaces that root as soon as it boots.
   - Call `GET /api/tracking?shipment=…&postcode=…&brand=&codePays=fr` with the
     token as `RequestVerificationToken`, as the official bundle does. Check the
     answered URL still names the same shipment and postcode.
2. Parse the JSON from the captured body or the `<pre>` a browser navigation
   wraps it in. `Expedition.Numero` must match the requested number or its
   embedded 8-digit shipment before anything else is read.

A customer-reported association between references does not override this
identity check. Outbound and return legs keep separate tracking identities;
references with an unresolved prefix remain corpus evidence.

Without a browser service (`FLARESOLVERR_URL`) the lookup fails at once with a
`ChallengeError`. Lookups are serialized per adapter instance (`singleFlight`)
so the token and the API call stay on one browser identity. Errors: warning
reply → `NotFoundError`; no token → `ChallengeError`; well-shaped number without
a postcode → `InputRequiredError`; malformed number → `InvalidInputError`; a reply
for another shipment → `SchemaError`.

## Notes

- Credentials: short numbers (8, 10 or 12 digits) need the 5-digit French
  recipient postcode, typed separately or appended. 10- and 12-digit forms are
  a 2-digit brand plus the 8-digit shipment (plus parcel sequence); the API
  echoes only the 8-digit shipment.
- 26-digit label barcodes need no postcode. Both modulo-11 check digits and the
  parcel sequence are validated; the first 12 digits are the public alias used
  for links and lookups.
- Never read the barcode's routing suffix as a postcode: it looks like one, and a
  wrong postcode returns another parcel or nothing.
- The postcode is part of the credential: kept out of logs, links and fixtures.
  The tracking link carries `numeroExpedition` only.
- Status comes from the `SuiviContextuel` headline, then events, then the
  highest reached milestone (its label, then its number). The deciding stage is
  set as `current_stage`, because the status vocabulary has no pickup value and
  the sync would otherwise fall back to "out for delivery".
- Timestamps are offset-less Paris wall-clock. A bare calendar day stays a day.
  The estimate is reduced to a day and dropped once delivered or in exception.

## Mobile API

The official [consumer Android app](https://play.google.com/store/apps/details?id=com.mondialrelay.mobile)
uses `https://mobile-app-bff.mondialrelay.app/`. Requests carry a shared app
signature with a nonce and Unix timestamp. `GET /api/parcels-search` accepts
`shipmentUid` and `postcode`; `GET /api/parcels-detail` accepts `shipmentUids`
and `parcelType`. Both also require an account JWT.

`GET /api/parcel-detail-not-migrated?shipmentUid=…` accepts the app signature
without an account JWT or postcode. The app uses it for non-exported sent
labels. Its summary replies contain shipment identity and delivery metadata,
without tracking events or scan times, so they cannot replace the public
website history. The returned numeric UID combines the brand and the complete
eight-digit shipment number; the brand remains part of the identity.

## Rejected approaches

- Direct HTTP first, browser as fallback: Cloudflare returns a 403 WAF block to
  every non-browser client, from several networks. It never succeeded and only
  burned time.
- Deriving the postcode from the 26-digit barcode: those digits are routing
  data.
- Mapping milestone numbers first: they show progress-bar position, not what
  happened.
- Keeping the Point Relais name: the reply doesn't separate it from the
  address block, so the whole block is skipped.
- Reading timestamps as UTC: the backend is Paris; offsets would be wrong half
  the year.

## Limitations

- French recipient postcodes only; other destination countries are untested.
- No event location: the reply's only place fields belong to the relay.
- Relay address, contacts and coordinates, recipient name and postcode are never
  read; the offline test asserts none reach the result.

## Testing

`npm run test:carriers:live -- testing/browserProtectedCarriers.live.test.ts`
runs without a browser service, so it only checks the wrong-number or challenge
error.
