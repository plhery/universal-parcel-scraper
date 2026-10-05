# Posti

Finnish postal operator, including Finnish delivery of foreign-issued postal numbers. Tracked
through the anonymous consumer GraphQL flow behind [posti.fi/en/tracking](https://www.posti.fi/en/tracking).
Finnish-issued postal numbers are candidates for recognition through the same anonymous
lookup. The [UPU S10 standard](https://www.upu.int/UPU/media/upu/files/postalSolutions/programmesAndServices/standards/S10-12.pdf)
names the issuing country, not the deliverer, so the suffix alone never selects Posti.
Posti's own 21-character parcel IDs, `JJFI` and seventeen digits, do select it.
Foreign-issued numbers are reached through a `posti.fi` link, an explicit pick or routing.

## How it works

1. `direct`:
   - `POST https://auth-service.posti.fi/api/v1/anonymous_token` (no body) returns an
     anonymous role token and an ID token. The session is cached until the earlier expiry,
     minus 30 seconds.
   - `POST https://graphql.posti.fi/graphql` runs `SearchShipments` with `PUBLIC_SHIPMENTS`,
     the identifier and English locale. Role token in `Authorization`, ID token in
     `X-Posti-Token: Bearer …`. No browser, cookie, key or page bootstrap.
2. `refresh`: after HTTP 401/403 or GraphQL `Unauthorized`, fetch a new anonymous session once
   and replay. Throttling, parser failures and other GraphQL errors are not retried.

Bootstrap, lookup and refresh share one cancellable 15-second budget.

## Notes

- The query in [adapter.ts](adapter.ts) selects only tracking fields, measurements and the
  public pickup-point name. Recipient address, pickup code and payment fields are never
  requested.
- `displayId` must match exactly. Duplicate matches and multi-parcel overviews are rejected.
- Only an error-free `totalHits: 0` with empty `hits` is not-found; partial or malformed
  responses stay failures.
- Parcel-level enums (`status.main`/`subStatus`) and each event's English label are mapped
  independently. The main status wins even when its scan is missing, and past events never
  inherit it.
- Pickup availability is not delivery; transport back to the sender is not a completed
  return. Notification and pre-advice rows prove no movement.
- `reasonDescription` is shown but never used to classify.
- Registration labels describe repeated handling during transport. Country arrival and
  readiness for delivery remain transit until a scan identifies the delivery round.
- Only timestamps with explicit offsets are kept; missing or ambiguous times stay unset.
- Measurements need a known unit and a positive finite value.
- Main status enums come from Posti's public parcels bundle
  (`cdn.posti.fi/omaposti/parcels/public/remoteEntry.js`). Endpoint discovery started from
  [hatlabs/posti-cli](https://github.com/hatlabs/posti-cli) (MIT); code and fixtures here are
  independent.

## Limitations

- No sender or recipient name: the public search does not expose them.
- Old parcels past Posti's retention return not-found, as on Posti's own tracker.

## Testing

`npm run test:carriers:live -- carriers/posti`. Without env vars it checks
two not-found cases; set `POSTI_TRACKING_NUMBER` to also check a real shipment.
