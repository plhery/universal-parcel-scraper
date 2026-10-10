# Correos Express

Tracks 16-digit shipment references through the anonymous public tracking form,
and the 23-digit parcel labels. Other reference formats use the universal
providers. Both lengths end in a GS1 check digit, which detection requires.

## How it works

One form POST returns the shipment label and its scan table. Both the visible
label and hidden shipment field must match the requested reference. No session
bootstrap, postcode or browser is needed.

## Notes

The form looks an input up as a shipment number and as a sender's own reference,
so a short input can return someone else's shipment. That is why the label and
the hidden field must both echo the request. A 23-digit parcel label opens with
the shipment number less its check digit, then gives the parcel's position, the
destination postcode and its own check digit. Its page names that shipment, so
the label is accepted when the hidden field echoes it and the visible label
shows the shipment it opens with, which becomes the canonical number. The
postcode never leaves the label, and the corpus keeps only synthetic labels.

Scans retain the carrier's newest-first order. Their clocks have no stated zone,
so valid digits remain local time and unresolved labels remain provider text.
The catalog zone is `Europe/Madrid`, so aggregators relaying the same clocks read them
as Spanish time.
Calendar estimates retain date-only precision while the delivery is active;
estimates older than the latest scan are omitted. A rescheduled round does not establish dispatch.
Only recognized status labels and the locality column are retained. A failed
delivery round has no label, only a note that opens with "Su envío no ha podido
ser entregado" and then gives the reason; that opening is kept as a failed
attempt and the reason is dropped, since it can name the recipient. Other scans
with missing or unrecognized labels remain neutral tracking updates, so an older
delivery does not become current. Free-form explanations, contact fields and
proof of delivery are excluded.

The initial page contains every error message hidden in its markup. A negative
requires the server-selected no-history code and the matching request echo;
other form-only responses remain inconclusive.

## Testing

Set `CORREOS_EXPRESS_TRACKING_NUMBER` to an authorized real reference and optionally
`CORREOS_EXPRESS_UNKNOWN_NUMBER` to a valid-looking unknown reference, then run
`npm run test:carriers:live -- carriers/correos-express`.
