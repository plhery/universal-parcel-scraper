# Jyldam Logistics

Jyldam's [public tracker](https://jyldam-logistics.kz/site/) follows shipments within
Kazakhstan. Select Jyldam and pass the full JL shipment reference from the waybill.

The carrier's form sends that reference to a guest JSON lookup. The adapter checks
the tracking source and returned reference. The published example returns a shorter
label, so the adapter also checks the earliest dated event against the reference year.
Events retain the local date and minute supplied by the carrier.

The sample returns request acceptance and confirmation. Both are registration
milestones. The rendered page also supports QazPost numbers and phone lookup.

Run the live test with `JYLDAM_LOGISTICS_NUMBER` set and
`npm run test:carriers:live -- carriers/jyldam-logistics`.
