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
- Stages come from the `parcelStatus` enum, no carrier wording rules. The enum
  is stable, and wording would only add a chance to be wrong. The enum was read
  from the carrier's public bundle `gcp-prd.my-deliveries.de/tnt/bundle/tnt-bundle-v2.js`.
- A row with an unknown code carries no stage of its own: the shared wording
  classifier reads its text. As the newest row, with nothing saying delivered,
  it reports the shipment as `unknown` with the history intact. Defaulting to
  `in_transit` could hide a new failure code.
- Every row keeps its `parcelStatus` as `provider_code`. A row with
  `historyText` only changes stage when its code is mapped. A row without that
  text takes the code's own description instead of "Hermes tracking update",
  which changes its stored identity, so [identity.ts](identity.ts) keeps it at
  the same instant by its code.
- `parcelAttributes.delivered` is a second delivery signal, so a delivery
  reported under a code we don't know yet is still recognised.
- `EDL_BOOKED_DROPOFF` and `EDL_BOOKED_PARCELSHOP` are dropped: they are the
  recipient's delivery preference (a safe place, a ParcelShop), not a movement,
  and as the newest row they would move the parcel backwards.
- `pickup_point` is the ParcelShop holding the parcel, or the one the recipient
  collected it from: the shop's name, street and town from the reply's
  `address` block, read only when its `addressType` is `PARCELSHOP` and the
  newest row says the parcel waits there or was collected there. A booked shop
  the parcel never reached gives none.
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
- The `address` block is read only for a ParcelShop. A home, neighbour or
  safe-place address and the delivery preferences in the payload are never
  read.
- Hermes answers some numbers with a leading zero too many under the shorter
  barcode. The reply names another barcode than the one asked, so it is
  rejected as a different parcel.

## Testing

Live coverage is in `testing/expandedCarriers.live.test.ts` (no env vars). It
accepts history or the 404 expiry, and skips on a 403/429 network block.
