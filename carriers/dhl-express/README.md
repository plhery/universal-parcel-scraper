# DHL Express

DHL Express waybills through MyDHL+ and DHL's public tracking portal, separate from
the German DHL Paket adapter.

Detection shares the [MyDHL+ tracking page](https://mydhl.express.dhl/gb/en/tracking.html)'s
waybill check with the adapter. A passing check prioritizes a candidate; it does
not confirm the carrier or the existence of a shipment.

## Retrieval

`direct` asks the public `shipmentTracking` JSON endpoint for one waybill.
After an HTTP challenge or transport failure, `trawl` loads DHL's global tracking
page in a fresh context and captures its matching `utapi` response. The browser
lets the page complete its verification and repeat tracking after an HTTP 428;
the intermediate challenge is not a shipment answer. HTTP recognition never
launches a browser; browser recognition is a separate opt-in phase and retains
its history.

## Limits

The returned identity must match the whole waybill and the browser response must
identify the Express division. Reused waybills and empty histories stay inconclusive.
MyDHL+ facility clocks are preserved without invented offsets; the global portal's
explicit offsets provide dated instants. Recipient details, piece identifiers and
proof-of-delivery links are discarded. A blocked HTTP request requires a configured
browser service with the DHL Express capture helper.

## Testing

`npm run test:carriers:live -- carriers/dhl-express`

Set `DHL_EXPRESS_LIVE_TRACKING_NUMBER` and `TRAWL_URL` to exercise browser retrieval.
Carrier protection can reject HTTP and browser sessions. These failures stay
distinct from a missing waybill.
