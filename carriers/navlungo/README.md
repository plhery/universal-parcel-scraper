# Navlungo

Navlungo offers domestic and international freight and parcel services from Turkey.
This adapter reads the public domestic tracker for Navlungo's own 12-character
delivery number. It reads the shipment component the tracker sends to the browser
and verifies the returned delivery number before accepting the history.

The portal's clocks carry no offset. The adapter retains the local clock
shown on each line and leaves UTC last-update and delivery times empty. A
return to the warehouse is reported as an exception because the tracker does not
confirm that the parcel is back with the sender. The adapter omits private
addresses, partner links and merchant order references. International references
use a separate Navlungo portal. Select Navlungo explicitly for a domestic number.

## Testing

`NAVLUNGO_TRACKING_NUMBER=… NAVLUNGO_UNKNOWN_NUMBER=… npm run test:carriers:live -- carriers/navlungo`
