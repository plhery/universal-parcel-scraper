# Dragonfly Australia

Tracks parcels of Dragonfly's Australian delivery network, Intelcom's Australian arm, through
the anonymous tracking service behind its portal at `dragonflyshipping.com.au`. Its numbers
start with `DRNFLY`.

## How it works

1. `direct`: GET `dragonflyshipping.com.au/cfworker/v3/tracking/<number>/`, the service the
   portal's tracking page calls. It asks for no session, cookie or check.

- The service runs the Canadian Intelcom contract on a separate backend, as the Dutch one does:
  each answers only its own country's parcels. The adapter reads replies with the Intelcom parser
  (`parseDragonflyTracking`), with this network's own status codes, and rejects a reply that
  names another network as its `subsidiary`.
- An unknown number gets HTTP 200 with `success: false` and the code `not_found`; only that answer
  is not found. A Cloudflare page in place of JSON is a challenge.
- The short labels are marketing phrases, so the status codes give the stage. A failed delivery
  (590), an address the driver could not deliver to (595) and a parcel brought back to the
  station for another day (610) are failed attempts.
- Scan times are epoch milliseconds, so events keep their instants.
- The hour window the page shows once a driver has the parcel is the delivery estimate, and before
  that the day of the service's own estimate.

## Limitations

- Cloudflare refuses the whole site to networks outside the ones it allows, with an "Attention
  Required" page and HTTP 403, which the adapter reports as a challenge.
- The page names no sender and the service no recipient. Current replies carry no scan place; the
  suburb older replies put on a round or a delivery is the recipient's and is dropped.
- The service keeps a parcel for a few months; an older number answers not found.
- Detection has no rule for `DRNFLY` numbers, so they need the carrier chosen or a portal link.

## Testing

`npm run test:carriers:live -- carriers/dragonfly-au`

The live test tracks the first sample in `numbers.json`; `DRAGONFLY_AU_TRACKING_NUMBER` tracks
another number and `DRAGONFLY_AU_UNKNOWN_NUMBER` checks the not-found answer with another number.
