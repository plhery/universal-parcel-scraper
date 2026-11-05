# Frontier Courier

The native adapter reads Frontier's anonymous Carrier Logistics FACTS XML trace at
`tracking.carrierlogistics.com/scripts/fscf.pol/protracexml.htm?pronum=…`. The tenant belongs to
Frontier, and the returned whole PRO must match. Only an exact error naming that PRO establishes
absence; a missing route, WebSpeed failure or mixed reply does not. There is no broad numeric
rule or recognition probe.

The detailed history is read newest first, retaining local clocks and genuine town/province
remarks. Dispatching a pickup driver is registration, before freight custody. Delivery needs
agreement between the lifecycle, delivered flag and physical history. Signatory/POD data,
customer references, address fields and unitless weight are omitted. No estimate is inferred
from the shipping or delivery date.

Retrieval uses the caller's transport, signal and budget, with one network-only retry. Enabled
universal providers remain available when direct tracking is inconclusive.

Run `FRONTIER_CA_TRACKING_NUMBER=… FRONTIER_CA_UNKNOWN_NUMBER=… npm run test:carriers:live -- carriers/frontier-ca/adapter.live.test.ts` with private inputs.
