# Tusk Logistics

Tusk Logistics sells US e-commerce brands parcel delivery through a network of regional carriers.

## Retrieval

The guest tracking page renders over a Blazor Server connection. With a local Chromium
configured, the adapter waits for the shipment detail or the page's explicit missing-shipment
notice. A found reply must name the requested Tusk tracking number.

The adapter reads the transit table in page order. It preserves the reported wall clocks
because the table gives no offset. Proof-of-delivery images and the carrier partner's
tracking number are outside the scan history.

## Testing

`TRACKING_CHROMIUM_PATH=… TUSK_LOGISTICS_TRACKING_NUMBER=… TUSK_LOGISTICS_UNKNOWN_NUMBER=… npm run test:carriers:live -- carriers/tusk-logistics`
