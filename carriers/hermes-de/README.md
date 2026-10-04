# Hermes Germany

Hermes Germany (myHermes) parcels, tracked through the anonymous recipient
service the public page calls. Hermes Einrichtungs-Service (furniture) is
[hermes](../hermes/README.md). The former Hermes UK domestic service is
[evri-uk](../evri-uk/README.md), and its international service is
[evri](../evri/README.md).

## How it works

1. `direct`: `GET https://api.my-deliveries.de/tnt/v2/shipments/search/{number}`
   with `X-Language: de`. HTTP 404 is a clean not-found; any other error status
   stays an upstream error.

The response must contain exactly one parcel whose `barcode` equals the
requested number. Exact `(time, parcelStatus)` duplicates are dropped, and rows
are sorted newest first. Timestamps are read with their own offset (falling
back to `Europe/Berlin`) and stored as UTC.

## Notes

- Barcodes shared with Evri remain ambiguous across services. Longer Hermes
  barcodes retain their existing recognition. Numeric detection uses the
  published checksum as a preference, since other carriers can pass it too.
- Stages come from the `parcelStatus` enum only, no wording rules. The enum is
  stable, and wording would only add a chance to be wrong. The enum was read
  from the carrier's public bundle `gcp-prd.my-deliveries.de/tnt/bundle/tnt-bundle-v2.js`.
- An unknown code as the newest row, with nothing saying delivered, reports the
  shipment as `unknown` with the history intact. The sync then classifies the
  wording; defaulting to `in_transit` could hide a new failure code.
- `parcelAttributes.delivered` is a second delivery signal, so a delivery
  reported under a code we don't know yet is still recognised.
- `EDL_BOOKED_DROPOFF` is dropped: it is a preference booking made before
  collection, and as the newest row it would move the parcel backwards.
- Display text is `historyText`, with the mapped milestone description as
  fallback. The row's `status` field only holds generic buckets
  (`HAPPY`/`FINISHED`).
- The postcode-protected endpoint that returns the delivery address is never
  called: the app doesn't store addresses and this carrier needs no postcode
  otherwise.
- `HermesGermanyTrackingError` keeps its name and 404 status: the host's grouped
  live suite asserts both.

## Limitations

- History rows carry no scan location.
- History expires: an old delivered number answers 404, shown as not found.
- Hermes answers 403 to some networks, including GitHub runners.
- The recipient `address` block and delivery preferences in the payload are
  never read.

## Testing

Live coverage is in `testing/expandedCarriers.live.test.ts` (no env vars). It
accepts history or the 404 expiry, and skips on a 403/429 network block.
