# Cordelia Container Shipping Line

Select Cordelia Container Shipping Line explicitly and enter a bill of lading or a container number from the [guest tracker](https://cordelialine.com/).

## Retrieval

The adapter uses the site's separate bill and container queries and checks the reference on the result. It reads the dated equipment movements for a container or a bill that covers exactly one container. A bill covering several boxes can return a bill-level status. The adapter omits the individual boxes' histories in that case.

The [CORDIS operations manual](https://www.scribd.com/document/853399185/CORDIS-Exports-Operations-Manual) distinguishes discharge of the loaded container, dispatch to the consignee and receipt of empty equipment. The guest summary labels the last of these `Delivered`. The adapter uses the movement's equipment meaning and leaves that event unstaged. Its dates preserve the carrier's printed clocks. Schedule and ETA fields are omitted.

## Testing

`CORDELIA_SHIPPING_TRACKING_NUMBER=… CORDELIA_SHIPPING_CONTAINER_NUMBER=… CORDELIA_SHIPPING_UNKNOWN_BILL=… npm run test:carriers:live -- carriers/cordelia-shipping`
