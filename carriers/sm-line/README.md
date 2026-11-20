# SM Line

SM Line tracks ocean freight through its [e-Service cargo portal](https://esvc.smlines.com/smline/CUP_HOM_3301.do?sessLocale=en). Select the carrier explicitly and enter a single-container bill of lading, with or without the `SMLM` prefix.

## Retrieval

The adapter submits the guest bill search and checks the returned bill number. It sends the listed container, booking and movement identifiers to the movement endpoint, then checks the movement identifier on every row.

The response gives local times at each port. Only actual movements appear in the history. Truck gate movements document terminal handling. Empty equipment pickup and return stay visible without changing the cargo stage. Multi-container bills need a shipment-level interpretation of their separate histories.

## Testing

`SM_LINE_TRACKING_NUMBER=… SM_LINE_UNKNOWN_NUMBER=… npm run test:carriers:live -- carriers/sm-line`
