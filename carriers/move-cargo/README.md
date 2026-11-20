# Move Cargo

Move Cargo delivers parcels and freight across Alberta, Saskatchewan and Manitoba.

## Retrieval

The public tracking page accepts one `tracking_number` query parameter. The
adapter restores the dash in six-digit `MC-` references after SDK normalization. A result
repeats the whole reference in the shipment card. The card supplies the current
status and service, and marks completed movements with `is-done`. The adapter
returns those movements newest first and leaves future stops out of the history.
The scan clocks omit the year, so each is retained as `provider_time_text`.

## Samples and testing

The carrier's [tracking page](https://movecargo.ca/track) links to three demo
consignments. Each fixture contains the result card returned by that live page.

`MOVE_CARGO_TRACKING_NUMBER=MC-100188 npm run test:carriers:live -- carriers/move-cargo`
