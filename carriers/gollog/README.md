# GOLLOG

The adapter tracks GOLLOG's air waybills when the caller selects GOLLOG. The separate invoice
lookup also needs the sender or recipient's tax identifier.

## Retrieval

The public page sends the waybill to `/api/services/app/Tracking/GetAllByCodes`. The response
must name the complete waybill. A reply with `found: false` and no scans means it was not found.
A listed waybill without any status yet has no history.

The adapter reads the scan's location and time with its supplied offset. Manifest entries are
omitted, as they are in the public timeline. The release milestone means ready for pickup on a
store-collection shipment and out for delivery on a home-delivery shipment. The estimate is
left out because the tracker gives only the day and month.

## Testing

`GOLLOG_TRACKING_NUMBER=… GOLLOG_UNKNOWN_NUMBER=… npm run test:carriers:live -- carriers/gollog`
