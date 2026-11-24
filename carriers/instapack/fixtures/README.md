# Fixtures

Pages of `https://back.instapack.es/client-dashboard/seguimiento-de-envios/`, kept as the tracker serves them.

- `delivered.html`: the parcel's page for the first public sample in [`numbers.json`](../numbers.json), an
  AliExpress parcel delivered after two incidents for an absent recipient.
- `delivered-order-id.html`: the parcel's page for the second sample, one of Instapack's own order ids, delivered
  in Madrid. Its driver's steps come oldest first, the first sample's newest first.
- `not-found.html`: the form again, with HTTP 200 and its message, for an invented code.

The delivery addresses, the drivers' names and phones are replaced by placeholders, and the map's script, which
holds the coordinates, is left out.
