# X-Cargo

Guest tracking for X-Cargo's Fontylink group consignments in Colombia, through
the Big Smart platform used by its official widget.

## Retrieval and scope

The adapter reads the shared visitor bearer from the public widget script at
`x-cargo.co/wp-content/uploads/BigTracking/big-tracker.min.js`, then requests
`GET api.bigsmart.mx/api/order-logs/{number}?populate=true&language=es` with the
widget's origin. No account or recipient input is needed. Fresh configuration
avoids copying an expiring credential into the adapter.

Both canonical tracking identities and every scan's order binding must agree.
The record must belong to Fontylink, which X-Cargo names as part of its
[holding group](https://x-cargo.co/about-us/). Other clients on the shared platform
do not establish X-Cargo ownership. The adapter supports complete sixteen-digit
references without adding a shared numeric detection rule or HTTP recognition.
An operating-carrier label is not converted into a guessed catalog handoff.

Only the exact HTTP404 missing-record envelope establishes absence. An empty
history, unsupported group, refusal or malformed reply remains a separate failure.
One network-only retry restarts the two-request flow inside the caller's deadline.

## History and clocks

Registration does not establish custody. Assignment to a route stays in transit;
the operator's actual dispatch establishes out for delivery. A return to the
delivery station is not a return to sender. All source rows are validated before
projected deduplication and the output cap; unknown codes keep history partial.
Notes, recipient/proof fields, employees, contact details and GPS are omitted.

Scan clocks retain their stated GMT offsets, including offsets on Colombian
records that differ from the catalog's Bogota zone. The country does not justify
replacing an explicit source offset. Equal-time scans retain their source order.
Driver estimates and map data are not parcel delivery promises, so no ETA is
inferred from them.

## Testing

Set `XCARGO_TRACKING_NUMBER` and optionally `XCARGO_UNKNOWN_NUMBER` outside the
repository, then run `npm run test:carriers:live -- carriers/xcargo`.
