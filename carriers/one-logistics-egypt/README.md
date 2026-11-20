# ONE Logistics Egypt

[ONE Logistics](https://onelogisticseg.com/) operates air, ocean and road freight services in Egypt. Select ONE Logistics Egypt explicitly and enter the freight reference with its original separators.

The [Arabic guest tracker](https://onelogisticseg.com/ar/) sends the reference to `POST /wp-json/one-logistics/v1/track`. The adapter restores the case of the carrier’s `Freight/` prefix, verifies the echoed reference and returns the carrier’s file status.

The published shipment returns `Closed File` with an empty log. That wording describes the freight file and leaves the delivery stage unresolved. The web form displays the day of the lookup when the log is empty. The adapter preserves the summary without assigning that date to the shipment.

```sh
ONE_LOGISTICS_EGYPT_TRACKING_NUMBER=Freight/2025/158 \
  npx vitest run --config vitest.carriers-live.config.ts carriers/one-logistics-egypt/adapter.live.test.ts
```
