# LM Parcel

The native adapter uses the public search page's anonymous summary POST and details GET. The
single search result must echo the whole requested reference, and every detail row must name the
same waybill. Only the bound empty search signature establishes absence. Partner barcodes keep
their issuer's detection and can propose a separate confirmation lookup.

The numeric scan values encode facility wall digits through the China clock. The parser reads
those digits with each row's stated offset, then orders known instants. Missing offsets stay
local and preserve source order. Facility processing and local-courier handoff are transit;
assigning a last-mile reference is an administrative notice. Staff metadata, contact and delivery
position details are omitted. There is no ETA in the observed reply.

Retrieval uses the caller's transport and budget, with one network-only retry. Refusals, rate
limits and malformed replies remain distinct, so enabled universal providers can still help.

Run `LM_PARCEL_TRACKING_NUMBER=… LM_PARCEL_UNKNOWN_NUMBER=… npm run test:carriers:live -- carriers/lm-parcel/adapter.live.test.ts` with private inputs.
