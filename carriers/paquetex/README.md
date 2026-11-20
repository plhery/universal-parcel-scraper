# PaquetEx

PaquetEx (Jump Express LLC) sends boxes from the United States to Mexico and Central America.
Use the box number or the full PaquetEx tracking reference at the [guest tracker](https://paquetex.net/tracking).

The adapter reads the same `GET /api/tracking?q=…` response as the page. A short box number
must match the returned box ID and a full reference must match the canonical tracking number.
The tracker can ignore the country prefix when searching by its numeric suffix. The adapter
rejects those mismatches and leaves partner-only FedEx results for the FedEx adapter.

The tracker timestamps status changes. Awaiting pickup and pickup scheduling
are preparatory steps. The adapter keeps those changes in the history and
uses the current status marked by the carrier. Select PaquetEx explicitly.

Set `PAQUETEX_NUMBER` and run
`npm run test:carriers:live -- carriers/paquetex` to verify a sample.
