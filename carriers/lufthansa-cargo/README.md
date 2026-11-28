# Lufthansa Cargo

Lufthansa Cargo tracks freight on a master air waybill with its IATA prefix 020. Enter the whole waybill or its
eight-digit serial.

## How it works

1. `direct`: `GET https://api-external.lufthansa-cargo.com/stp/shipments-details/020<serial>`, the request the
   [eTracking](https://www.lufthansa-cargo.com/en/eservices/etracking) page's script makes, with no account, token
   or key. The service answers plain HTTP clients although Cloudflare challenges the eTracking page itself. The
   reply names the waybill it answers, which must be the one asked for.

## Notes

- Each status-history row holds a planned and an actual event with the station's clock and offset, which are
  kept. Rows not done yet become planned events. The history keeps the tracker's order.
- The wording comes from the tracker's own translations. A manifest and a discrepancy (offload, missing, found or
  overcarried pieces) keep the stage before them; a pickup notice or a delivery away from the waybill's destination
  is a step on the way.
- A waybill the guest tracker does not show comes back with `isAvailable: false` and no history, which the page
  words "The AWB has not been found or requires login". It is read as not found. Lufthansa Cargo drops waybills a
  few months after their flights, so older public waybills come back this way.
- A refusal (HTTP 403 or a verification page), an HTTP 404 or an unreadable reply is a changed service, never a
  missing waybill.

## Limitations

- The fixtures for tracked waybills are synthetic, shaped as the tracker's script reads the reply: every public
  waybill found had already left the guest tracker.
- The milestone plan, booking and eFreight details, pieces, weights and the time of availability are not kept.
- A waybill page names the prefix and serial as separate path parts, which the catalog's link template cannot
  split, so the catalog links to the eTracking form.

## Testing

`LUFTHANSA_CARGO_TRACKING_NUMBER=… LUFTHANSA_CARGO_UNKNOWN_NUMBER=… npm run test:carriers:live -- carriers/lufthansa-cargo`
