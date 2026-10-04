# Nova Poshta (Ukraine)

Tracks Ukrainian Nova Poshta waybills through the official anonymous `TrackingDocument/getStatusDocuments` API. Nova Post international services and Nova Poshta Global numbers use separate portals and are outside this adapter's scope.

The `direct` step requests a status without an API key or recipient phone. The result is a summary, with no invented scan history. The carrier's receipt timestamp establishes delivery time when present; booking and metadata refresh times cannot date the current status.

Full movement history and recipient details require a separate access flow. The adapter retains neither credentials from frontend bundles nor personal shipment fields. Unknown status codes remain unmapped.

Live test: `NOVA_POSHTA_TRACKING_NUMBER=… npm run test:carriers:live -- carriers/nova-poshta`.
