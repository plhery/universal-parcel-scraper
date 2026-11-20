# CPX Guatemala

Select CPX Guatemala and enter the reference on your shipment. The
[Pio Tracking guest form](https://tracking.cpxbox.com/) takes that number.
Use the dashes from the printed reference on the carrier's page. The adapter
restores the dashes for the compact form of the published FGUA sample.

The guest lookup provides dated status codes and locations. CPX reports an
invoice and a payment separately from transport milestones. The adapter
uses CPX's explicit store-collection wording to identify pickup readiness
and retains payment as a dated event. The adapter preserves scan clocks
without an offset as local times.

Set `CPX_GUATEMALA_NUMBER` and run
`npm run test:carriers:live -- carriers/cpx-guatemala` to check a public sample.
