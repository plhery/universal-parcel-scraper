# MTE Xpress

MTE Xpress is a South African road and air freight courier based in Germiston, Johannesburg.

## Retrieval

The guest Ship Logic portal reads its provider id from the public provider directory. The
adapter sends the reference and MTE Xpress's provider id to its shipment lookup. It requires a
single shipment from that provider with the same waybill or short reference. The service's
HTTP 404 naming the requested reference means it has no result for that reference.

The adapter reads shipment-level scans and keeps the offset in each scan's timestamp. It uses
the shipment status for the summary and keeps the service level. Status codes and their
wording are Ship Logic's, read as [Internet Express](../internet-express/README.md) reads
them, and the operational events the portal hides stay out. Piece scans, addresses,
free-text scan notes and delivery estimates are omitted.

## Testing

`MTE_XPRESS_TRACKING_NUMBER=… MTE_XPRESS_UNKNOWN_NUMBER=… npm run test:carriers:live -- carriers/mte-xpress`
