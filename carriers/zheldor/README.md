# Zheldorexpeditsia

JDE forwarding receipts are tracked through the public page’s QR guest flow. It creates a
fresh anonymous DataSnap session and posts the whole receipt reference to
`https://i.jde.ru/vM/GetDataTrack` with `qr: true`. The page supplies a shared PIN placeholder
for this view. Recipient PINs and the separate document/account routes are not used.

The root identity and every scan must name the whole receipt. Only the service’s exact,
number-bound missing reply establishes absence; verification refusals and other HTTP or
changed-schema replies keep their failure kinds. A network retry opens a new guest session.

The API lists scans newest first. The adapter keeps that order and the facility wall clocks,
which carry no offset. Actions the source marks erroneous are omitted. Telephone and SMS
notices keep the preceding stage. Contact fields, coordinates, documents and delivery
estimates are not projected.

## Numbers

The public input takes sixteen digits, printed in four groups of four. Other carriers share
that shape, so no detection rule or HTTP recognizer claims it. Explicit carrier selection
and a named handoff with a matching receipt can use the adapter. Samples and provenance are
in [`numbers.json`](numbers.json).

## Testing

`npm run test:carriers:live -- carriers/zheldor`, with `ZHELDOR_TRACKING_NUMBER` and optionally
`ZHELDOR_UNKNOWN_NUMBER` supplied outside the repository.
