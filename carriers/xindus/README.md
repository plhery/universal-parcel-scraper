# Xindus

Xindus Trade Networks, of Gurugram and Jaipur, consolidates exports from India: parcels by air,
freight by air and sea to the United States and the United Kingdom, and stock for Amazon's
warehouses. Its site is xindus.net. The adapter tracks its air waybills through the lookup its
tracking page makes. Select the carrier explicitly.

## How it works

1. `direct`: one `GET https://os.xindus.net/ixos-service/oapi/shipment-tracking/shipment?scancode={number}`,
   with no cookie, token or browser. The JSON reply has the shipment's status and its boxes,
   each with its scans and the carrier that delivers it in the destination country.
2. `retry`: the same read once more after a network failure or a hang.

- The shipment in the reply must be the number asked.
- An unknown number is HTTP 500 with a description asking for a valid AWB, which is read as not
  found; the tracking page also reads an empty list as not found. Another 500, a 404 or a
  reply that is not JSON is a failure, never a missing shipment.

## Notes

- Each scan gives a wall clock and the zone it was written in: Indian time for Xindus's own
  scans, the delivery carrier's local zone for the scans Xindus relays from it. Scans become
  instants in that zone and are ordered by them, since Xindus lists some out of order. A scan
  without its zone fails the lookup rather than guess one.
- The delivery carrier's scans arrive under Xindus's own codes, with that carrier's wording as
  the description. The current stage comes from the shipment's status.
- The delivery carrier and its number are kept when a shipment has one box, the catalog knows
  the carrier by its name and link, and that carrier's rules offer the number.
- Scans from several boxes are merged, and a scan repeated across boxes is kept once.
- The reply names the staff account that wrote each of Xindus's own scans; the adapter does
  not read it.

## Limitations

- Order references, which the tracking page also takes, are outside scope: the shipment found
  must carry the number asked.
- No estimated delivery is read; the page shows only its day.
- No exception, return or failed delivery has been seen live, so their codes fall to the
  shared wording rules.

## Numbers

Its air waybills are X followed by nine digits in the public samples; that shape is too
generic to claim, so there is no rule.

## Links

`www.xindus.net/tracking?awb=<number>` looks the number up on load, and the library reads the
number from `awb`.

## Testing

`npm run test:carriers:live -- carriers/xindus`, with `XINDUS_TRACKING_NUMBER` and optionally
`XINDUS_UNKNOWN_NUMBER` set outside the repository.
