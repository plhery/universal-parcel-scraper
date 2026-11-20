# JAS Worldwide

Select JAS Worldwide to track air and ocean freight by MyJAS shipment number or house bill.
The public shipment grid resolves the reference, and the grid's read action returns the
milestones. The adapter verifies the house bill and shipment number against the grid before
using the details.

Completed milestones retain the carrier's wall clocks where it gives no offset. A container's
delivery advances the history, while the shipment's own delivery sets the delivered stage.
The detail action is identified by the public grid's build and may need updating when MyJAS
changes it.

Set `JAS_WORLDWIDE_TRACKING_NUMBER` and run
`npm run test:carriers:live -- carriers/jas-worldwide`.
