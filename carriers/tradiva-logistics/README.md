# Tradiva Logistics

Select Tradiva Logistics and enter the native shipment number or a freight
reference accepted by the [guest tracker](https://tradivalogistics.com/tracking-1/).
The adapter submits the single lookup field and checks the returned shipment
number, container or bill reference against the lookup.

It reads Tradiva's shipment status, the dated timeline, locations, freight mode
and estimated arrival day. The carrier shows local clocks without offsets.
The progress rail also displays future milestones without scan dates.
The adapter reads events from the separate shipment history.

The carrier’s demo opens through either its shipment reference or the
container number in the public form.

Set `TRADIVA_LOGISTICS_NUMBER` and run
`npm run test:carriers:live -- carriers/tradiva-logistics` to verify the sample.
