# CTT Express

Its former name, Tourline Express, is an alias. Tracks single-piece Spanish shipment references and complete package codes through the anonymous JSON route
used by the official public tracking app.

## How it works

One GET requests shipment history using the complete input. The returned shipment must match exactly and
its package code must identify the sole package according to the carrier's
[label specification](https://transfer.cttexpress.com/IT/export/integra/Shipment_Number_Calculation_and_Package_Codes_of_CttExpress.pdf).
Package inputs retain their counter and must match the returned package exactly.
The public response contains only one package's scans, so a multi-piece shipment's
reference stays inconclusive: it answers with another package's scans, which cannot
say the shipment is complete. A package code of a multi-piece shipment reads its own
package's scans. Portuguese postal references use the universal providers.
A few percent of lookups get an error reply, the one the tracking page shows as "Ha ocurrido un
error". CTT repeats it for that shipment for a quarter of an hour or more while other shipments
read normally, so it is not read again at once; the parcel reads on a later poll, and the
exception uses a fixed description to keep recipient details out of diagnostics. A body that is not JSON and a request that
fails to reach the service are read once more. A number with no shipment gets HTTP 200 with an empty body, which the
tracking page reads as a shipment it has not located; two empty reads in a row are not found.
Every code in CTT Express's [agency list](https://transfer.cttexpress.com/IT/export/integra/CANALREC.csv)
starts with `00`, so detection offers it a reference only when both its agency codes do. TIPSA
numbers share the agency, agency, counter layout, and TIPSA's agencies in provinces 01 to 09 start
with `00` too. Detection selects CTT Express when the origin agency, the second code, is in that
list, and otherwise offers both carriers for recognition to settle; an agency added to the list
since it was copied into the rule is offered that way too.

## Notes

The feed provides ascending scans with explicit offsets. Histories are projected
newest first; unresolved newest clocks retain their place and local digits or
provider text. Pickup availability and returns in progress do not complete a
delivery. An explicit return start establishes the sender-bound leg across later
movement scans; completed delivery on that leg means returned. The outbound
estimate stays suppressed throughout the return. The portal's presentation rail
can fill in future milestones, so only actual scan rows are retained. Empty
histories, histories holding only customer service cases, token errors and
unbound error replies remain inconclusive. Calendar estimates retain their date-only precision
for active deliveries when they are no older than the latest dated scan. Pickup,
delivery, incidents and document holds suppress estimates. A rescheduled
delivery day replaces the committed one. The weight is the one measured in the
network, else the one the sender declared. A parcel that entered from another
postal network keeps that network's S10 number as its international number. CTT Portugal
tracks its own numbers, those ending in `PT`, so such a number also names CTT Portugal as the
delivery partner and the tracker asks it about the parcel. On such a parcel, the delivery steps
CTT Express relays from CTT Portugal (out for delivery, a failed attempt, the delivery and
availability at a pickup point) carry Lisbon's wall clock with Madrid's offset: CTT Portugal's
own rows of the same scans are an hour later to the second. Those steps are read on Lisbon's
clock. CTT Express's own scans before the hand-over keep the instant it gives.
Customer service cases are skipped: they are not scans and carry the
recipient's contact details. Other measurements, contact information and
free-form delivery comments are excluded.

## Testing

Set `CTT_EXPRESS_TRACKING_NUMBER` to an authorized real Spanish reference and run
`npm run test:carriers:live -- carriers/ctt-express`.
