# Joom Logistics fixtures

Replies of the tracking interface's `GET /api/0.1/trackings`, whole and pretty-printed. They hold no
recipient details.

- `delivered-us.json`: the reply for a public USPS barcode in [`numbers.json`](../numbers.json), a
  parcel from Japan through Joom Logistics' Hong Kong centre, flown to Los Angeles, carried by Pitney
  Bowes and delivered by USPS. Its USPS scans come without a code, each beside Pitney Bowes' own row
  for the same moment.
- `delivered-ru.json`: the reply for a public S10 number, a parcel from a Dongguan warehouse to
  Russia, delivered by Russian Post. Its order system's rows name the order.
- `delivered-de.json`: the reply for a public Hermes number, a parcel from Japan through Hong Kong,
  flown by SEKO to Liège and delivered by Hermes in Germany.
- `not-found.json`: the reply for an invented number, HTTP 404 naming the number.
