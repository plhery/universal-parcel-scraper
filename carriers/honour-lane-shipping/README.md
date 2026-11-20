# Honour Lane Shipping

Honour Lane Shipping publishes [container details](https://tracking.cargolane.net/tracking/ShipmentInfo) through CargoLane. Select the carrier explicitly and enter the container number. Containers can be reused across sailings. The adapter returns the history for that container from the lookup currently served by Honour Lane.

## Retrieval

The adapter loads the same container lookup as the guest page. It checks the exact container in both the container tab and the history map. It reads actual milestone times from `statusTime`, keeping the offsetless clock readings. Scheduled milestones have a separate timestamp and stay out of the scan history.

Full container gate-in is acceptance. Vessel and rail movements stay in transit, including arrival at a terminal at the place of delivery. Empty equipment movements stay visible without changing the cargo stage.

## Testing

`HONOUR_LANE_SHIPPING_TRACKING_NUMBER=… HONOUR_LANE_SHIPPING_UNKNOWN_NUMBER=… npm run test:carriers:live -- carriers/honour-lane-shipping`
