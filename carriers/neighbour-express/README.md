# Neighbour Express

The adapter reads Neighbour Express's return-label history through its public guest page.
The page obtains its own reCAPTCHA v3 token and posts the whole reference. A compatible
TRAWL capture helper reads the browser's decoded JSON and returns selected tracking fields.
The response must identify exactly one matching return label. Scan clocks keep each event's
stated offset, including when it differs from the destination's seasonal clock.

Return references beginning with NR, or N with R as the sixth character, use this
postcode-free route. Other shipment branches require the recipient's postcode and remain
with enabled providers. No number rule or HTTP recognizer claims these overlapping shapes.
Public samples and their sources are in [numbers.json](numbers.json).

A rejected v3 score asks the native page for an AJ image challenge. The adapter can try one
fresh guest context while its budget holds another read; an unfinished check remains a
challenge. The AJ slider is not solved by this adapter. Empty or unconfirmed histories do
not establish that a parcel is missing. Malformed replies, transport failures and rate limits
stay distinct. Contacts, free-form notes, signatures, cookies and verification state are omitted.

## Testing

`npm run test:carriers:live -- carriers/neighbour-express`, with
`NEIGHBOUR_TRACKING_NUMBER` and optionally `NEIGHBOUR_UNKNOWN_NUMBER` supplied outside Git.
Use TRAWL with the Neighbour Express decoded capture helper.
