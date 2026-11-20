# Obana Logistics

Select Obana Logistics and enter its shipment reference. The adapter uses the
same number-only lookup as the [carrier’s public tracker](https://logistics.obana.africa/)
and verifies the reference in the reply.

The adapter reads the carrier’s current status, its timestamped event history,
the service level and destination country. The tracker shows a progress rail
alongside the observed events. Event history comes from the dated tracking log.

Set `OBANA_LOGISTICS_NUMBER` and run
`npm run test:carriers:live -- carriers/obana-logistics` to verify a sample.
