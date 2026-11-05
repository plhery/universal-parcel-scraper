# Freightways Global

The native adapter reads the public GoSweetSpot page at `track.fgmailconnect.co.nz/?id=…`.
It supports the verified single-parcel inbound import labels and their GSS/account aliases. The requested
reference, heading and separate tracking identities must agree, and the shipment must identify
FG International's customs and final-mile handover leg. A partner-only page is insufficient.
DAI Post keeps detection of its labels; there is no new broad number rule or recognition probe.

All history rows are read, including the hidden parcel-detail rows used for identity checks.
Customs-data notices are administrative. Scan clocks stay local in source order; service duration
and the page's delivery date are not an ETA. Account links, per-parcel barcodes and freeform
references are omitted: these imported labels need sender-account context at NZ Couriers, so no
bare-number partner lookup is inferred. Empty search results remain inconclusive because histories
expire.

Retrieval uses the caller's transport, cancellation and aggregate budget, with one network-only
retry. Enabled universal providers remain available.

Run `FREIGHTWAYS_GLOBAL_TRACKING_NUMBER=… FREIGHTWAYS_GLOBAL_UNKNOWN_NUMBER=… npm run test:carriers:live -- carriers/freightways-global/adapter.live.test.ts` with private inputs.
