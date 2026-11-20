# Thai Nexus

[Thai Nexus Tracking](https://tracking.thainexus.co.th/) shows dispatch, movement
and delivery for the carrier's own shipment reference. Select Thai Nexus and use
the reference from the dispatch confirmation. The carrier also publishes one
live demo that uses a separate hyphenated form.

The adapter reads the HTML rendered by the public result page. It checks that the
result echoes the reference and uses the timestamps with explicit offsets from the
history. It keeps the status labels and omits shipment details, partner notes and
free-text locations. The timestamp of the last movement comes from the history.

Run the live test with `THAI_NEXUS_NUMBER` set and
`npm run test:carriers:live -- carriers/thai-nexus`.
