# Rosalia Express

The [Rosalia Express tracker](https://www.rosalia-express.com/cek-paket) takes
the number printed on the shipment receipt. Select Rosalia Express and enter
that number with its leading zeros.

The adapter opens a fresh guest form and submits the same anonymous component
request as the page. The reply echoes the receipt and supplies local scan times.
The adapter keeps station labels where the tracker identifies a station.
The carrier uses the same short status for travel and the local delivery run.
The longer delivery wording identifies the latter.

Run the live test with `ROSALIA_EXPRESS_TRACKING_NUMBER` set and
`npm run test:carriers:live -- carriers/rosalia-express`.
