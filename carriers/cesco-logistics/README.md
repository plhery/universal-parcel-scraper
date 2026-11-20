# CESCO Logistics

Select CESCO Logistics and enter the air waybill from the Indonesian carrier.
The [guest tracker](https://cesco-logistics.com/tracking.php) requires
the dash between the first three and last eight digits. The adapter inserts it
when handed the compact form.

The adapter submits the same form POST as the tracker and verifies the echoed
waybill. It keeps the completed milestones and their local scan times. The
timeline supplies the shipment status. The delivery photo and recipient name
are omitted.

Set `CESCO_LOGISTICS_TRACKING_NUMBER` and run
`npm run test:carriers:live -- carriers/cesco-logistics` to check a public sample.
