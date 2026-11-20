# FlechaCarga

The adapter reads retained legacy Buspack receipt history through the public form's service.
It obtains the shared guest token from the carrier-published tracking script, then requests the
whole receipt. No account, recipient credentials or document lookup is used.

The official form keeps the four-digit branch and converts the receipt serial to a number.
The response must name Buspack or FlechaCarga, repeat that complete receipt in its result heading, and contain its own dated
history table. Only the exact number-bound missing-operation reply means not found; other errors,
changed milestones and ambiguous identities leave fallback available. Arrival at the destination
agency does not by itself assert pickup readiness.

Scan clocks retain their local minutes without an offset. The SDK can infer a summary zone from
the catalog; no delivery instant is asserted. Contacts, cargo descriptions, payment details and
internal operation metadata are omitted. Modern FLC guides and delivery-number-only searches
remain outside this adapter's verified scope.

The form's receipt link takes separate letter, branch and serial parameters, so the catalog opens
its search page without splitting a number into a generated link. No detection rule is added.

Run live tests with `FLECHACARGA_NUMBER` outside Git and
`npm run test:carriers:live -- carriers/flechacarga/adapter.live.test.ts`.
