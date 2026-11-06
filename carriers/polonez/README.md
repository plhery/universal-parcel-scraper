# Polonez

Tracks the current labels of Polonez's US-to-Poland service through the public
[Meest tracker](../meest/README.md) its site embeds. Older labels remain on enabled
universal providers. Existing number detection stays unchanged; the native adapter
accepts only the current documented label families.

## Retrieval

The adapter shares Meest's guest page, short-lived public salt and signed XML
lookup. It keeps its own parser: Polonez rows have no Meest status code. All three
own label fields must match the whole requested label on every row. A sender-only
or partner-reference match cannot establish Polonez ownership. Empty retained
history is inconclusive because the portal removes old shipments.

The newer JSON iframe omits scans and shifts some clocks, so it is not the source
of history. No account, recipient credential, browser or CAPTCHA is needed for the
XML route. Network failures get one recorded retry within the caller's budget;
an expired cached salt gets one refresh. HTTP errors and malformed replies keep
their failure kinds.

## Interpretation

UPS delivery to the origin warehouse and arrival at the EU distribution center
remain transit. Recipient delivery needs the Polish leg; final-mile pre-advice and
a delivery expectation establish no new stage. The explicit GLS label note gives
the Polish delivery partner and its reference only when the shipment also
establishes a consistent Polish destination. Unknown wording stays a generic
update and marks the answer partial for enabled provider enrichment. Contacts, detail messages, internal references and proof links are omitted.

Clocks retain their wall digits and source precision without an offset. Relayed
scans span countries and do not share a proven zone. Date-only rows stay dates;
no delivery instant or ETA is invented. Long histories are bounded and marked
partial so richer enabled providers remain available.

## Live test

Set `POLONEZ_TRACKING_NUMBER` outside the repository and run
`npm run test:carriers:live -- carriers/polonez/adapter.live.test.ts`.
Optionally set `POLONEZ_UNKNOWN_NUMBER` to check empty retained history.
