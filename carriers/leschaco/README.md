# Leschaco

Leschaco operates an international freight network and issues house bills of lading through [AC Container Line](https://www.leschaco.com/en/global-presence/emeai/germany/ac-container-line.html). Select Leschaco explicitly and enter the issued reference. The adapter recognizes the same reference with or without the `ALRB` carrier code.

The [Visible guest tracker](https://visible.leschaco.com/) calls `GET /v1/Tracking/Anonymous/{reference}`. A search can return other shipment rows alongside the matching bill. The adapter keeps the row with the exact shipment number and reads only movements Leschaco marks as actual. It preserves the carrier’s local clock when the response supplies no offset.

The carrier can mark a shipment as finished when the equipment returns empty. The adapter keeps the empty gate-in as an equipment movement without classifying it as consignee delivery. It omits estimates, vessel and equipment identifiers, and customer details.

```sh
LESCHACO_TRACKING_NUMBER=ALRB261013270093 LESCHACO_UNKNOWN_NUMBER=ALRB241217210064 \
  npx vitest run --config vitest.carriers-live.config.ts carriers/leschaco/adapter.live.test.ts
```
