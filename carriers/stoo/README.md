# STOO

STOO is operated by Start Today, a South Korean cross-border parcel carrier. The Japanese [Qoo10 carrier guide](https://article-university.qoo10.jp/entry/164) lists STOO for international shipments. Select STOO explicitly and enter the reception number issued by the carrier.

The [STLine guest tracker](https://stline.stload.com/tracking) calls `GET /api/external/tracking/{reference}`. The adapter verifies the returned reception number, reads the current Korean status and keeps dated history entries marked as passed. The carrier reports local clocks without offsets. Warehouse processing remains visible as an event with no mapped stage.

The adapter omits the related merchant order and domestic delivery identifiers, estimates and handoff carrier details.

```sh
STOO_TRACKING_NUMBER=ST230047655JP \
  npx vitest run --config vitest.carriers-live.config.ts carriers/stoo/adapter.live.test.ts
```
