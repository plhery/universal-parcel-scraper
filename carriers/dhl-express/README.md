# DHL Express

DHL Express waybills through MyDHL+, separate from the German DHL Paket adapter.

## Retrieval

`direct` asks the public `shipmentTracking` JSON endpoint for one waybill.
After an HTTP challenge or transport failure, `trawl` loads the recipient tracking
page and captures its matching shipment response. HTTP recognition never launches
a browser; browser recognition is a separate opt-in phase and retains its history.

## Limits

The returned identity must match the whole waybill. Reused waybills and empty
histories stay inconclusive. Each facility reports a local clock without an offset;
these clocks are preserved, so consumers can request a universal source for dated
instants. Recipient details, piece identifiers and proof-of-delivery links are discarded.
A blocked HTTP request requires a configured browser service.

## Testing

`npm run test:carriers:live -- carriers/dhl-express`

Carrier protection can reject HTTP and browser sessions. These failures stay distinct from a missing waybill.
