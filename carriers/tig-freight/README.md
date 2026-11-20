# TIG Freight

TIG Freight manages Australian freight booked with partner carriers through Open360.

## Retrieval

The adapter sends the guest `Shipment` query to `api.open360.com/tracking/graphql` and reads
the scan list only when the reply names the entire requested shipment reference. It keeps an
offset when supplied and otherwise reads the scan as a wall clock. Scan details appear in
the order shown on the tracking page.

## Limitations

This adapter covers the Open360 endpoint by direct shipment reference. The legacy OpenFreight
endpoint requires browser access and the historic consignment shown in TIG's webinar has no
history in Open360. The success fixture is synthetic and follows the public tracker's query.
Partner carriers issue their own numbers, so the adapter runs when TIG Freight is selected.

## Testing

`TIG_FREIGHT_TRACKING_NUMBER=… npm run test:carriers:live -- carriers/tig-freight`
