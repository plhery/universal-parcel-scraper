# Vidhi Transport

Select Vidhi Transport explicitly and enter the lorry receipt number from the [guest tracking page](https://www.vidhitransport.com/lr-track.html).

## Retrieval

The guest form calls the carrier's ERP and shows the current consignment status. The adapter checks the returned receipt number and preserves the status update's printed time. It returns a summary because the ERP does not expose a movement history through this form. A route endpoint and a delivery estimate do not establish where a scan occurred.

## Testing

`VIDHI_TRANSPORT_TRACKING_NUMBER=… VIDHI_TRANSPORT_UNKNOWN_NUMBER=… npm run test:carriers:live -- carriers/vidhi-transport`
