# DHL eCommerce Netherlands

DHL's parcel network in the Netherlands and Belgium, formerly DHL Parcel
Benelux, through the gateway behind its tracking page. German DHL Paket is
[dhl](../dhl/README.md) and the Americas network is
[dhl-ecommerce](../dhl-ecommerce/README.md).

## How it works

1. `direct`: `GET api-gw.dhlparcel.nl/track-trace?key=…`, the request
   `my.dhlecommerce.nl` makes for a parcel opened without a postcode. It returns
   one shipment with an oldest-first event feed. An unknown key is a 404 with a
   fixed sentence, which is the only answer read as a missing parcel.

## Notes

- The key is sent without a postcode. The gateway then leaves out the
  recipient, the address, the signature and the ServicePoint, so there is
  nothing personal to discard and no place on a scan.
- Events carry a status code and a category, no text. The wording is the
  English translation the tracking page loads, kept in
  [statuses.json](statuses.json) with the stage of each code. It is stored
  rather than fetched so a scan reads the same on every lookup.
- A code missing from that list takes the stage of its category. The page
  files clearance and courier scans in categories that also hold sorting scans
  and next-day plans, so those two categories only mean movement.
- A delivery or a return to the sender stays the current stage when a notice
  follows it.
- A ServicePoint notice that failed to reach the recipient still means the
  parcel waits there, as the notice that was sent does. "Handed over to the
  courier" is the depot's hand-over for the delivery round, just before it
  goes out, so it reads as out for delivery.
- A scan can carry a planned window or a single expected moment, both with
  offsets. The newest one is the estimate; a scan with both counts as its
  window, as on the tracking page. A delivery, a parcel waiting at a
  ServicePoint or a later scan clears it.
- The feed repeats a scan it received from two systems; one is kept.
- The gateway also follows parcels of DHL's European road network that enter
  the Benelux, including German `JJD` numbers. Detection leaves those with DHL
  Paket; the adapter accepts them when the carrier is named.

## Limitations

- Scans have no location.
- `3S` numbers are accepted by the adapter and claimed by no detection rule:
  no public sample was found to tell them from PostNL's.

## Testing

`npm run test:carriers:live -- carriers/dhl-ecommerce-nl` checks that a
synthetic number gets a clean not-found. Set
`DHL_ECOMMERCE_NL_TRACKING_NUMBER` outside the repository to read a real parcel.
