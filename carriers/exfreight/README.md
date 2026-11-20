# ExFreight

ExFreight Zeta is a US freight forwarder and licensed ocean transport intermediary. It consolidates less-than-container-load shipments and arranges domestic and international freight. Select ExFreight explicitly and enter the ten-digit Exfresso shipment number.

The [public Exfresso tracker](https://exfreight.flipstone.com/track) opens numbered results at `/track/{trackingNumber}`. The shipment row shows a prefixed reference, and the adapter matches its numeric suffix against the requested number before reading the tracking updates.

The adapter keeps dated transport and clearance milestones, collapses duplicate rows, and reads the carrier’s delivery summary. Tracking updates shown at midnight have calendar-date precision. Other updates retain their explicit time zones where supplied. A matched shipment can report delivery with no dated movements. The adapter omits addresses, names, notes, internal route details, and projected dates.

The fixtures contain response excerpts from the carrier’s public guest pages. Run the live checks with the published references.

```sh
EXFREIGHT_TRACKING_NUMBER=1747977505 EXFREIGHT_SUMMARY_NUMBER=1620999313 \
  npx vitest run --config vitest.carriers-live.config.ts carriers/exfreight/adapter.live.test.ts
```
