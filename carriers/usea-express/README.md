# USEA EXPRESS

USEA EXPRESS ships for cross-border e-commerce sellers from China to Europe by rail, truck, sea
and air, with its own customs clearance in several European countries, overseas warehouses and
deliveries to Amazon warehouses.

## Numbers

The number field on its tracking page shows two numbers made of `USEA` and fourteen digits as
examples. No other public page shows one, so no rule claims them.

## Retrieval

The ordering app’s guest tracker reads `/api/express/track/list/<number>` and lists the shipment’s scans newest first. Both examples printed by USEA have the same four movements. Each reply identifies the requested number. The scans cross time zones and carry no offsets, so their clocks stay local.

## Testing

`USEA_EXPRESS_TRACKING_NUMBER=… USEA_EXPRESS_UNKNOWN_NUMBER=… npm run test:carriers:live -- carriers/usea-express`
