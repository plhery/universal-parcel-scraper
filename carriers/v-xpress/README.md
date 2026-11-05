# V-Xpress

The native adapter posts a docket to the public tracker at `vxpress.in/sx_trackapi.php`,
using the current page's `iTrackingNumber` and `isTrace=1` fields. Both the shipment summary
and movement heading must match the whole docket. Explicit selection and named handoffs
reach it; shared numeric formats receive no detection or recognition rule.

The timeline keeps its unoffset scan clocks. The summary's delivery clock differs from the
timeline without stating a zone, so it supplies neither a delivery instant nor an estimate.
Any zone a consumer deduces remains separate from the source clock. Labels precede custody;
assigning trips, data dispatch, account edits and proof administration do not establish movement.
Mobile dispatch alone supplies no custody stage. Unknown detail text is represented as a generic
update because that field can embed contact details. Recipient and shipper information, mixed
locations, references, proof links and raw detail text are omitted.

The exact empty `Docket Not Found......` reply establishes absence. Mixed results, malformed
markup, refusals and rate limits stay distinct, with enabled provider fallback available.
Retrieval uses verified HTTPS, the caller's transport, cancellation and aggregate budget,
cache revalidation and one network-only retry. It needs no session or browser bootstrap.

Run `VXPRESS_TRACKING_NUMBER=… VXPRESS_UNKNOWN_NUMBER=… npm run test:carriers:live -- carriers/v-xpress/adapter.live.test.ts` with private inputs.
