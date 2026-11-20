# Litegua Express

Select Litegua Express and enter the numeric guide from the [electronic guide form](https://apps.litegua.com/rastreoweb/ge.php). That public form accepts the guide on its own.

## Retrieval

The adapter submits the electronic guide and checks the full number printed on the result. It reads the history table's date, time, status and agency fields. Customer fields and descriptions of contents are omitted. The separate courier form requires a tax ID and is outside this adapter's scope.

Express routing and transfers indicate movement within the network. Generic readiness wording stays unstaged because it can appear before a route is assigned or while the shipment awaits handover.

## Testing

`LITEGUA_CARGO_TRACKING_NUMBER=… LITEGUA_CARGO_UNKNOWN_NUMBER=… npm run test:carriers:live -- carriers/litegua-cargo`
