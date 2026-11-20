# JPI Jakarta Cargo

Select JPI Jakarta Cargo and enter the shipment number from the receipt. The carrier's [public tracker](https://www.jpicargo.com/tracking) covers shipments between Malaysia and Indonesia.

## Retrieval

The adapter uses the JSON lookup behind the public tracker. It verifies the full shipment number and checks that every scan belongs to the same shipment record. The history keeps the carrier's dated status codes and the wall clocks it prints. Names, addresses, contact details, supporting photos and delivery notes are omitted.

`RECEIVED JPI` records carrier acceptance. Unloading and shipping between branches are in-transit movements. The short `PICKUP` code stays unstaged until the response establishes what was picked up.

## Testing

`JPI_JAKARTA_CARGO_TRACKING_NUMBER=… JPI_JAKARTA_CARGO_UNKNOWN_NUMBER=… npm run test:carriers:live -- carriers/jpi-jakarta-cargo`
