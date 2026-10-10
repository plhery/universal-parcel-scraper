# Poczta Polska

Tracks registered postal items and parcel barcodes through the official
eMonitoring widget's anonymous JSON service. Polish-issued postal numbers are
candidates for recognition through the same lookup. The
[UPU S10 standard](https://www.upu.int/UPU/media/upu/files/postalSolutions/programmesAndServices/standards/S10-12.pdf)
names the issuing country, not the deliverer, so the suffix alone never selects
Poczta Polska.

## How it works

The adapter reads public widget configuration from eMonitoring, then requests
one parcel's history. No account or browser is required. Both returned parcel
identifiers must match. A 19-digit reference receives the same check digit that
the official widget appends before lookup.

Local detection checks complete numeric barcodes against the
[widget's check-digit calculation](https://emonitoring.poczta-polska.pl/widget/widget.tracking.min.js).
Only 20-digit barcodes under Poczta Polska's GS1 prefix `5900773` are
prioritized; other SSCCs belong to their shippers. Passing checks prioritize a
candidate without confirming a shipment. Shorter
aliases have no check digit to validate and remain shape-based suggestions.

## Notes

Specific scan codes determine progress. An unsuccessful delivery can carry the
broader “in delivery” state, so that state does not override the scan. The one
state read on its own is “returned”: from that scan on, the item travels back,
and a final delivery means the sender has it again. Weight is provided in
kilograms. Office names provide locations, and the office holding an item for
collection is its pickup point; a delivered item has none. The destination country is the two-letter code
the service gives, and the mail type, such as Pocztex or EMS, is the service name; office addresses, opening hours and payment documents are
excluded.

An item from abroad arrives at an inward office of exchange and passes customs
before delivery. Its collection at the office is a delivery. A customs
settlement can follow days later: it books the duty collected at delivery and
moves nothing, so the scan before it stays current. A delivery scan at a Polish
office dates the delivery.

## Limitations

Clocks carry no offset. A scan at a Polish office, which carries an office type,
is read on Polish time (`Europe/Warsaw`). Scans relayed from partners abroad,
office-less scans such as electronic pre-advice, and wall clocks that a
daylight-saving change skips or repeats keep their local digits. Scans keep the
provider's order. See [ROUTING.md](https://github.com/plhery/delivery-tracker/blob/main/docs/ROUTING.md) for
unresolved history handling. Empty history, invalidated scans, ambiguous
reused numbers and unregistered letter post, which the service answers with its mail type
alone, are inconclusive. Pallet consignments and references with linked
components need parcel-level history and are not supported.

## Testing

Run `npm run test:carriers:live -- carriers/poczta-polska`.
Set `POCZTA_POLSKA_TRACKING_NUMBER` outside the repository for a real parcel.
