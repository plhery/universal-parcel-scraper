# RIST Transport

RIST Transport operates less-than-truckload and truckload freight across the northeastern United States. Select RIST Transport explicitly and enter the numeric PRO number from the freight bill.

The [public carrier tracker](https://ltl-tracking.risttransport.com/shipmenttrace.htm) exposes shipment details at `boldetail.htm?nav=top&wbtn=PRO&wpro1={trackingNumber}`. The adapter verifies the PRO shown in the shipment details before reading the milestone table.

The parser preserves carrier-local scan times, handles the legacy zero-hour AM notation, and publishes city and state when shown as a location. It deduplicates repeated delivery scans. Manifest and appointment records have no physical movement stage. The adapter omits names, addresses, proof of delivery, and free-form notes.

Run the two live checks with published PRO numbers.

```sh
RIST_TRANSPORT_TRACKING_NUMBER=21509962 RIST_TRANSPORT_SECOND_NUMBER=11169582 \
  npx vitest run --config vitest.carriers-live.config.ts carriers/rist-transport/adapter.live.test.ts
```
