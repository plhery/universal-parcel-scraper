# Interlogistica

Tracks the Bulgarian courier's waybills. Interlogistica also delivers some GLS
shipments in Bulgaria under their existing numbers.

## Retrieval

The public tracking form posts the waybill in `edTrackingNumber`. The matching
form response names the waybill above its scans. An empty results area in that
same response means the tracker has no record.

Each scan keeps the Bulgarian operation, local clock and location. A row
labelled as an unentered operation stays in the history without advancing the
shipment's stage.

## Numbers

Select Interlogistica explicitly. The tracker takes the number through its form.

## Testing

`INTERLOGISTICA_TRACKING_NUMBER=… npm run test:carriers:live -- carriers/interlogistica`
