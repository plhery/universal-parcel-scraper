# Flywing Cargo

Select Flywing Cargo and enter the eight-digit goods receipt number in [its public tracker](https://flywingcargo.com/tracking/). The adapter reads the server-rendered consignment page and checks the full GR number in both the heading and details table.

The journey lists dated milestones and sometimes a location. The adapter keeps the clocks as printed and uses the separate consignment status as the current state. In the published example the transit timestamp is later than the delivery timestamp, while the consignment status says `DELIVERED`. Both dates appear in the history. The time attached to the current status comes from the matching delivery milestone.

The carrier publishes `20051234` in its tracking form. Its live lookup returned four movements on November 20, 2026. The fixtures omit names, cargo contents and free-text remarks.

```sh
FLYWING_CARGO_TRACKING_NUMBER=20051234 FLYWING_CARGO_UNKNOWN_NUMBER=00000000 npm run test:carriers:live -- carriers/flywing-cargo
```
