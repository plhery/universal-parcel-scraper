# Neighbour Express

The adapter follows the public tracking page's own split between two routes.

Return references beginning with NR, or N with R as the sixth character, are read through the
page's verified return route. The page obtains its own reCAPTCHA v3 token and posts the whole
reference. A compatible TRAWL capture helper reads the browser's decoded JSON and returns
selected tracking fields. The response must identify exactly one matching return label.

Every other reference goes to the shipment route over plain HTTP, as the page sends it: the
reference and a postcode field, which the page leaves empty when opened from a tracking link
and the service does not check. The adapter sends it empty, so no postcode is asked for. The
reply must name the whole reference as the package or its sub-order. An empty list or the
page's not-found code is a missing shipment; the route's retry-later answer is an outage. The
page treats a 900 row, or a 203 row in a history without one, as completion; the status map
reads both codes as delivered. Other rows are read by the map, then by their English wording. Cities are kept as places;
scan addresses, destinations, photos and signatures are left out.

Scan clocks keep each event's stated offset, including when it differs from the destination's
seasonal clock. No number rule or HTTP recognizer claims these overlapping shapes. Public samples
and their sources are in [numbers.json](numbers.json).

A rejected v3 score asks the native page for an AJ image challenge. The adapter can try one
fresh guest context while its budget holds another read; an unfinished check remains a
challenge. The AJ slider is not solved by this adapter. On the return route, empty or
unconfirmed histories do not establish that a parcel is missing. Malformed replies, transport failures and rate limits
stay distinct. Contacts, free-form notes, signatures, cookies and verification state are omitted.

## Testing

`npm run test:carriers:live -- carriers/neighbour-express`, with
`NEIGHBOUR_TRACKING_NUMBER` and optionally `NEIGHBOUR_UNKNOWN_NUMBER` for the return route
(TRAWL with the Neighbour Express decoded capture helper), and `NEIGHBOUR_SHIPMENT_NUMBER` and
optionally `NEIGHBOUR_UNKNOWN_SHIPMENT` for the shipment route, supplied outside Git.
