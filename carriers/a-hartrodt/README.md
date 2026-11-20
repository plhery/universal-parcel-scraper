# a. hartrodt

Track a house air waybill or forwarding bill of lading in a. hartrodt's public
[Tracking & Tracing form](https://ttsecure.hartrodt.com/pserv/tt/open?sep=1).
The adapter submits the reference in the HAWB/FBL field. It uses the job number
field for the carrier's three-letter, sixteen-digit job references.

The search returns a job list. The adapter follows only a matching row on the
carrier's own host and checks the reference again in the shipment details
before reading the dated messages. The messages include GMT offsets, which
the adapter keeps in the timestamps. The route's ETA concerns the vessel
or flight, so it is excluded from the delivery estimate.

Select **a. hartrodt** explicitly. Run the live checks with the published numbers.

```sh
A_HARTRODT_TRACKING_NUMBER="$PUBLIC_NUMBER" A_HARTRODT_UNKNOWN_NUMBER="$PUBLIC_MISS" \
  npm run test:carriers:live -- carriers/a-hartrodt/adapter.live.test.ts
```
