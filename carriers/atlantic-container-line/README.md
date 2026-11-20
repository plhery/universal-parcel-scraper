# Atlantic Container Line

Atlantic Container Line tracks ocean freight through its [guest Track & Trace page](https://www.aclcargo.com/track-trace/). Select the carrier explicitly and enter a single-container SA shipment number, with or without the `ACLU` prefix and the hyphen after `SA`.

## Retrieval

The adapter sends the dashboard's shipment search and matches the whole SA number. It fetches the movement grid for the returned container and checks both identifiers on every row. The page embeds the grid data as JSON inside a script, which the adapter reads without running the script.

The tracker gives scan times without offsets. Terminal handling and vessel movements count as transit. Empty container moves stay visible without changing the cargo stage. Multi-container bills need a shipment-level interpretation of the separate histories.

## Testing

`ATLANTIC_CONTAINER_LINE_TRACKING_NUMBER=… ATLANTIC_CONTAINER_LINE_UNKNOWN_NUMBER=… npm run test:carriers:live -- carriers/atlantic-container-line`
