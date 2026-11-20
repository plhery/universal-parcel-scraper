# Airways Courier

Select Airways Courier to track an Indian consignment through its public waybill page.
The page reports the canonical waybill and the reference together. The adapter requires
the lookup to match one of those whole values and verifies the waybill against the heading.

The history supplies a date for each scan and a clock in the delivery wording. The adapter
keeps those precisions and shows facility names with their contact details removed.

Set `AIRWAYS_COURIER_IN_TRACKING_NUMBER` and run
`npm run test:carriers:live -- carriers/airways-courier-in`.
