# Dragonfly Netherlands

Tracks parcels of Dragonfly's Dutch delivery network, Intelcom's Netherlands arm, through the
anonymous tracking service behind its portal at `dragonflyshipping.nl`. The Amazon parcels it
delivers carry `AMZNL` numbers.

## How it works

1. `direct`: GET `dragonflyshipping.nl/cfworker/v3/tracking/<number>/`, the service the portal's
   tracking page calls. It asks for no session, cookie or check.

- The service runs the Canadian Intelcom contract on a separate backend: each answers only its
  own country's parcels. The adapter reads replies with the Intelcom parser
  (`parseDragonflyTracking`), with this network's own status codes, and rejects a reply that
  names another network as its `subsidiary`.
- An unknown number gets HTTP 200 with `success: false` and the code `not_found`; only that answer
  is not found. A Cloudflare page in place of JSON is a challenge.
- The short labels are marketing phrases, so the status codes give the stage. A failed delivery
  (590) and a parcel brought back to the depot for another day (610) are failed attempts.
- Scan times are epoch milliseconds, so events keep their instants.
- The hour window the page shows once a driver has the parcel is the delivery estimate.

## Limitations

- The page names no sender and the service no recipient. Scan places in current replies are
  empty, so events have no location. The delivery place a delivered scan describes is dropped.
- The service keeps a parcel for a few months; an older number answers not found.
- Detection has no rule for `AMZNL` numbers, so they need the carrier chosen or a portal link.

## Testing

`npm run test:carriers:live -- carriers/dragonfly-nl`

The live test tracks the first sample in `numbers.json`; `DRAGONFLY_NL_TRACKING_NUMBER` tracks
another number and `DRAGONFLY_NL_UNKNOWN_NUMBER` checks the not-found answer with another number.
