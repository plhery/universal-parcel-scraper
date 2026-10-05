# Nova Poshta (Ukraine)

Tracks Ukrainian Nova Poshta waybills through the current official public site's shipment API, including movements tied to a declared redirected waybill. Nova Post international services and Nova Poshta Global numbers use separate portals and are outside this adapter's input scope.

The `direct` step requests anonymous movement history without an API key or recipient phone. Completed and current movements establish progress; dated future milestones remain plans. Each movement must belong to the returned shipment, parcel or delivery reference. Return and payment references cannot establish forward delivery. Explicit timestamp offsets are preserved, and unknown status codes remain unmapped.

After an inconclusive retrieval, `summary` requests the older anonymous `TrackingDocument/getStatusDocuments` API. That fallback returns a status summary, with no invented scans; only an explicit receipt timestamp can date delivery. Personal shipment details and credentials from frontend bundles are discarded.

Live test: `NOVA_POSHTA_TRACKING_NUMBER=… npm run test:carriers:live -- carriers/nova-poshta`.
