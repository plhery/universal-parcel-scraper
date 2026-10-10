# GLS Germany

GLS parcels in Germany. Same GROUP recipient service as GLS Switzerland, so the
parser, status map and URL builders are imported from `../gls-ch/`; see
[gls-ch](../gls-ch/README.md) for the endpoints, identity checks and status
handling. This folder only adds what differs.

## How it works

`direct`, always two requests, because the postcode is required here: the
`rstt029` overview, then `rstt028` with the parcel number, postcode and
`REQUEST` owner code. The overview's identity is validated before the postcode
is sent, so a wrong or expired number never transmits it. A request that fails
to reach GLS, or hangs, is sent once more, as in gls-ch.

## Notes

- A GLS parcel number is 11 digits, printed with a check digit as a 12th
  (weights 3, 1, 3, … from the right, plus one). Nine other carriers share
  the 12-digit shape, so detection offers GLS for it only when that digit
  passes. GLS numbers are never 13 or 14 digits.
- HTTP 404 is a not-found only when the body has GLS's `lastError: E000`.
  Otherwise it stays an upstream error: the service also returns 404 for
  challenges and invalid postcodes, which must not look like an expired parcel.
  Delivered parcels age out of public history and then return `E000`.
- The postcode is the recipient's, in any country's format: the GROUP service
  answers for parcels GLS delivers across its network, and this carrier is
  where a GLS parcel from another country is filed. GLS refuses fewer than three
  characters or a symbol as a wrong format (HTTP 400) and answers any other
  postcode that does not match with the same `E800` 404 as a wrong one.
- The result's timezone is relabelled `Europe/Berlin`. Both services run on
  CET/CEST, so only the label changes.
- `recognizes(number)`, the adapter's `recognize()`, queries the overview on
  the `/DE/en/` variant. It returns false only for a clean not-found and
  rethrows everything else, so an outage never reads as "not GLS". It never
  sends a postcode. Carrier recognition uses it, and the user is then asked for
  the postcode (see [ROUTING.md](https://github.com/plhery/delivery-tracker/blob/main/docs/ROUTING.md)).
- `GLSGermanyTrackingError` keeps its name because
  `testing/expandedCarriers.live.test.ts` asserts it. The constructor also
  accepts a positional timeout.

## Limitations

- Recognition cannot tell a German parcel from a Swiss one. The GROUP service answers
  for both networks, and its overview of a delivered German parcel names no owner. When
  both networks recognize a number, the more popular one, GLS Switzerland, is chosen.
  GLS Germany is reached through a German link or by picking it.

## Testing

No live test in this folder. `npm run test:carriers:live -- testing/expandedCarriers.live.test.ts`
checks that an expired public number returns `GLSGermanyTrackingError` before any
detail request.
