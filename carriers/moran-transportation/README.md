# Moran Transportation

The adapter reads Moran's Carrier Logistics XML trace for a whole ten-digit PRO. Select
the carrier explicitly. The reply must repeat the PRO, and the trace's invalid-PRO
message means no shipment only when it names the requested PRO.

The trace timestamps stay as local clocks because it supplies no time zone and the carrier
operates across multiple zones. The adapter keeps the event wording and facility remarks
that give a place. The trace's delivery flag settles delivery. Other shipment references,
parties and signature details are omitted.

Set `MORAN_TRANSPORTATION_TRACKING_NUMBER` and optionally `MORAN_TRANSPORTATION_UNKNOWN_NUMBER`
outside the repository and run `npm run test:carriers:live -- carriers/moran-transportation`.
