# Rocket Shipping

Rocket Shipping tracks US freight shipments, including large deliveries managed with partner carriers.

## Retrieval

The public tracker loads `/.netlify/functions/tracking?loadId=…` and returns the matching load
number. The adapter reads the customer-facing event list first, then uses the tracker’s notes
when the event list is empty. It uses the timestamps on those rows, since the summary text
describes delivery in a clock with no offset.

The tracking endpoint can answer HTTP 400 with a generic notes error. The adapter preserves
that as an upstream failure because the response does not establish that the load is missing.

## Limitations

Select Rocket Shipping or open a Rocket tracking link. The adapter looks up the Rocket load
number. Partner PRO numbers, purchase orders and shipper references require the portal’s search.

## Testing

`ROCKET_SHIPPING_TRACKING_NUMBER=… npm run test:carriers:live -- carriers/rocket-shipping`
