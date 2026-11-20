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

## Numbers

GOLLOG tracks a shipment by its air waybill: GOL's airline prefix 127, then an eight-digit serial
whose last digit is the remainder of the first seven divided by seven. Waybills print a dash after
the prefix, and rule `gollog-1` names GOLLOG for that dashed form, since 127 is GOL's own prefix.
Eleven digits without the dash fit several carriers' numbers, so the rule leaves them to those.

## Testing

`GOLLOG_TRACKING_NUMBER=… GOLLOG_UNKNOWN_NUMBER=… npm run test:carriers:live -- carriers/gollog`
