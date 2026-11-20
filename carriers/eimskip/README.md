# Eimskip

[Eimskip Find Shipment](https://www.eimskip.com/find-shipment/) publishes a shipment timeline. Select Eimskip explicitly and enter the shipment number shown by the carrier or the same reference with its EIMU bill prefix.

## Retrieval

The adapter submits the guest form and checks the shipment number in the reply. It keeps dated, completed milestones from the carrier's shipment timeline, including aggregate milestones when the same shipment covers multiple containers. The dates keep the wall clocks printed by the carrier.

Origin and destination in the shipment summary describe its route. The dated milestone rows name the vessel and do not identify a separate location for each event. Undated next steps and the summary refresh time are excluded from the history.

## Testing

`EIMSKIP_TRACKING_NUMBER=… EIMSKIP_UNKNOWN_NUMBER=… npm run test:carriers:live -- carriers/eimskip`
