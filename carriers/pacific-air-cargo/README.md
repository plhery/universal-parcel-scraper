# Pacific Air Cargo

Pacific Air Cargo carries freight between the continental United States, Hawaii and Pacific islands. Select Pacific Air Cargo explicitly and enter its own eight-digit serial with or without the `5YR` prefix.

The airline links to [PACTRAK](https://www.pactracking.com/track/), where it publishes a [numbered waybill lookup](https://www.pactracking.com/track/?AwbPrefix=5YR&awb=92203705). The result contains shipment and flight records in the HTML. The adapter verifies the requested waybill and associates flight movements with its flight number and flight date. It keeps the carrier’s local airport clocks in movement order across time zones.

The fixture confirms acceptance and a flight arrival at an intermediate airport. Arrival of a flight remains in transit. A recorded recovery counts as delivered when the pickup covers the tendered piece count. The adapter omits customer and delivery-order details and leaves the portal’s partner-airline prefixes outside this carrier’s scope.

```sh
PACIFIC_AIR_CARGO_TRACKING_NUMBER=5YR-92203705 npx vitest run --config vitest.carriers-live.config.ts carriers/pacific-air-cargo/adapter.live.test.ts --maxWorkers 1
```
