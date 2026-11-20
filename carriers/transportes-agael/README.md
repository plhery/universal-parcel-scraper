# Transportes AGAEL

Transportes AGAEL carries parcels from Lima to provincial branches in Peru. Select the carrier explicitly and enter the guide shown on the shipping receipt.

The [public tracking form](https://agaelsac.com/seguimiento/) sends the guide as the `codigo` query parameter. The carrier’s page confirms the guide and displays local scan times in day-month-year order. Each retained milestone comes from the shipment history. The adapter reads the origin for registration and the destination for a completed branch arrival.

The verified guide ends at `En destino`, when the shipment was unloaded at the destination branch. The portal has a separate `Entregado` status for completed delivery. `Despachado` records the addition to a manifest and has no physical movement stage. The adapter omits free-form notes and manifest references.

Run the live check with the guide published in the tracking form.

```sh
AGAEL_TRACKING_NUMBER=BLM064954 \
  npx vitest run --config vitest.carriers-live.config.ts carriers/transportes-agael/adapter.live.test.ts
```
