# MBG-Africa

Select MBG-Africa and enter its tracking number. Muremera Business Group
operates road, air and ocean freight services from Burundi. The [guest
tracker](https://mbg-africa.com/track.php) returns the current status, shipment
history and estimated arrival date.

The adapter reads completed history milestones and their printed local
clocks. The tracker does not specify a time zone for the scan times. Route
plans and document availability are outside the shipment history. The
publicly confirmed reference is the carrier's own demonstration shipment.

Set `MBG_AFRICA_NUMBER` and run
`npm run test:carriers:live -- carriers/mbg-africa` to check the live tracker.
