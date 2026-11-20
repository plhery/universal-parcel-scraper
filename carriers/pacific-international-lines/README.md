# Pacific International Lines

Pacific International Lines tracks ocean freight through its [guest Container T&T form](https://www.pilship.com/digital-solutions/?tab=customer&id=track-trace). Select the carrier explicitly and enter the container number. The tracker shows the history it currently serves for the equipment, which may have moved on more than one shipment.

## Retrieval

The adapter obtains the form's anonymous request state and then sends a container search with the same timestamp. It checks the whole container number on the movement table and keeps the carrier's offsetless clock readings.

Gate-in at the outbound terminal marks acceptance. Vessel and terminal handling count as transit. Empty equipment pickup and return stay visible without changing the cargo stage. The adapter covers container lookup, which exposes a dated movement grid.

## Testing

`PACIFIC_INTERNATIONAL_LINES_TRACKING_NUMBER=… PACIFIC_INTERNATIONAL_LINES_UNKNOWN_NUMBER=… npm run test:carriers:live -- carriers/pacific-international-lines`
