# GLS Canada

The adapter covers GLS Canada's domestic parcel tracker, formerly Dicom, when GLS Canada is
selected.

## Retrieval

The Canadian tracking widget sends an anonymous GET to `web.gls-canada.com/api/tracking/`.
The adapter reads the shipment whose complete tracking number matches the request. `NORECORD`
for that number means the carrier found no shipment.

A single parcel supplies its scan history in the carrier's order, with local terminal clocks.
For a shipment with several parcels, the adapter uses the shipment summary because the site
shows each parcel's history separately. The guest lookup gives service and scan locations.
The separate postal-code lookup for proof of delivery is outside its scope.

## Testing

`GLS_CA_TRACKING_NUMBER=… GLS_CA_UNKNOWN_NUMBER=… npm run test:carriers:live -- carriers/gls-ca`
