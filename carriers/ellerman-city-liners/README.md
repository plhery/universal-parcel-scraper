# Ellerman City Liners

Select Ellerman City Liners explicitly and enter a container number. Ellerman publishes its [container tracking widget](https://ellerman.orcapayments.app/container-tracking/) through its community portal.

## Retrieval

The adapter uses the widget's guest container search for Ellerman and checks the equipment number on every movement. It preserves the printed local time, carrier status code and movement location. It reads actual movement rows and leaves the vessel schedule out of the history.

A container can sail repeatedly under different bookings. The tracker can show a movement from a different sailing than the paperwork used to identify the container. Terminal gate-out counts as transit. Empty return stays in the history without implying cargo delivery.

## Testing

`ELLERMAN_CITY_LINERS_TRACKING_NUMBER=… ELLERMAN_CITY_LINERS_UNKNOWN_NUMBER=… npm run test:carriers:live -- carriers/ellerman-city-liners`
