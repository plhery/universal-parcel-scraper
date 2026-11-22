# DTDC

Tracks DTDC shipments through the official MyDTDC consumer feed, and through DTDC's
tracking page when the feed fails.

## How it works

The MyDTDC feed comes first: one anonymous GET returns the current state and scan
history. The returned consignment must contain the requested booking reference or
waybill. Related forward and return scans stay on their own legs, and the current
state remains a separate dated snapshot when it is absent from the scan list.

When the feed fails, the adapter asks the tracking page on www.dtdc.com as its script
does. `GET /wp-json/custom/v1/generate-captcha` returns a key and a picture of six
capital letters and digits, sealed with AES-GCM under a key the page gives every visitor.
The shared text model reads the picture with a white margin, as the letters reach its
sides, and `POST /wp-json/custom/v1/captcha/validate` exchanges the answer for a token. A
refused or misread picture is replaced up to three times. `POST
/wp-json/custom/v1/tracking/pull-details` with the token in `X-DTDC-Track-Token` returns a
sealed payload for `POST /trackshipment`, whose page must name the requested waybill or
reference. The page keeps a copy of the history for each of its states; the active one
is read, with its current scan, since a delivery appears only there. Its clocks are India's.
The page's "Shipment Details Not Found" notice, which repeats the number, is a missing
shipment; a web page in place of a JSON reply is not.

Return booking and movement keep active stages so later progress can be synced.
Only delivery on the return leg completes the return; it does not set a recipient
delivery time.
The stored scan does not keep the status label the parser reads first, so the parcel
app's review (`statusMap`) stages a scan only when its wording is such a label or a line
the parser reads without one, and gives a delivery no stage there, since it is not asked
by the leg. The page's remarks, lines without a label, repeat a scan's line a minute
later: a centre receiving the parcel on its way or the way between two hubs, read
`in_transit`. A booking's "Received at Origin Processing Center" comes with its label.

## Limitations

Some legacy consignments are unavailable in this feed. Its generic failure
message does not prove that a number is unknown. Recipient details, addresses,
booking information and unlabelled weight values are excluded.

Published legacy references can suggest DTDC without establishing that the
current feed retains their history. Detection keeps that distinction for legacy
waybills of one letter and eight digits: `N` waybills are selected, and the
other letters DTDC's former tracker is known to have answered are only
suggested. `A` waybills are left out: one DTDC reply shows one, and a Day & Ross
sample shares the shape. Consignments of one letter and ten digits are suggested
only for the letters public samples show DTDC answering; `Z` ones share Packeta's
shape and stay with Packeta.

DTDC's international consignments, `N` and eight digits, get the feed's generic
failure. DTDC Australia's open tracker, `GET www.dtdcaustralia.com.au/track_order/{number}`,
answers them from DTDC's international system. It matches the whole number in either case
and returns rows with a status, a free-text note and a place. When FedEx or DHL takes the
parcel abroad, a note names that carrier's label number and the partner's scans follow.
The adapter does not ask it: the reply does not repeat the number, the notes carry contact
addresses and staff names, and the clocks name no zone. Deliveries abroad fall in working
hours only when read as UTC.

The feed can answer every number with its generic failure for long periods. The tracking
page shows no scan location, and a return travels under its own waybill, which the page
links and the adapter does not follow. Pictures and lookups in quick succession get
HTTP 403, which stays a challenge.

## Testing

Set `DTDC_TRACKING_NUMBER` outside the repository and run
`npm run test:carriers:live -- carriers/dtdc/adapter.live.test.ts`.
