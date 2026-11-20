# Procon Express Lines

Cargo Marketing Services issues its own ocean house bills of lading as Procon Express Lines. Select this carrier explicitly. The adapter accepts the full bill of lading or the consignment reference printed after the `PCXS` carrier code.

The [public tracking form](https://cmsfreight.com/tracking/public-tracking/) opens a Cargo Marketing Services consignment frame. Enter the reference without `PCXS` when using that form. The adapter fetches the public frame directly and checks the returned consignment before reading its movement grid.

The carrier shows local dates and times and describes critical dates as estimates. The adapter preserves the clock values as reported. It reads booking and container movements, omits administrative messages and shipment details, and leaves port arrival and gate activity in transit.

Run the optional live checks against a published house bill and the carrier’s documented form example, which currently has no match.

```sh
PROCON_TRACKING_NUMBER=PCXS2ET26090083 PROCON_UNKNOWN_NUMBER=3XX16020022 \
  npx vitest run --config vitest.carriers-live.config.ts carriers/procon-express-lines/adapter.live.test.ts
```
