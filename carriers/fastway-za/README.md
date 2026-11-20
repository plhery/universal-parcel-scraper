# Fastway South Africa

The adapter covers the South African franchise's public label lookup when Fastway South Africa
is selected. Calling-card references that resolve to a different label require a verified alias.

## Retrieval

The public tracking page uses `/tracking-api21/`. Its JSONP envelope carries server-rendered scan
rows. The adapter reads the envelope as data and checks the complete label in the result heading.
The separate customer reference in the header is left out.

Scans keep the franchise's local clock, code, wording and location. A second pickup after a depot
scan is a handoff in transit. A signature can be from a regional on-forwarder, so the delivered
stage also requires the explicit delivery wording. The tracker uses the same no-scans reply for
unknown labels and labels still awaiting their first scan.

## Testing

`FASTWAY_ZA_TRACKING_NUMBER=… FASTWAY_ZA_UNKNOWN_NUMBER=… npm run test:carriers:live -- carriers/fastway-za`
