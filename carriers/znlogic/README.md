# Zinc

Zinc gives marketplace orders its own reference and relays the retailer's delivery scans. The
native adapter calls the public tracker's same-origin JSON route, with the whole Zinc reference
in its path. Positive replies do not echo an identifier: binding relies on that exact request
route without redirects. Only a shipment-specific 404 that echoes the whole reference means
not found; a missing route or generic error does not.

The feed's clocks have no offsets. They stay local rather than taking the company's headquarters
clock; consumer place or country enrichment retains its basis. Recipient ZIP and contact details are omitted.
A carrier name in a scan does not supply its barcode, so it cannot create a delivery handoff.
Unknown scan wording remains unstaged and no delivery estimate is inferred from the summary.

Retrieval uses the caller's transport and budget, with one network-only retry. Enabled universal
providers remain available when direct tracking is inconclusive.

Run `ZNLOGIC_TRACKING_NUMBER=… ZNLOGIC_UNKNOWN_NUMBER=… npm run test:carriers:live -- carriers/znlogic/adapter.live.test.ts` with private inputs.
