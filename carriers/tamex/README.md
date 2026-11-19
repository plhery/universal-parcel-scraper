# Tamex

Tamex tracks its Saudi shipments on its public `/track/{number}` page. Select the carrier
explicitly. The adapter requires the page to repeat the full number before using the history
or the explicit no-history message, which also covers expired records.

The tracker lists its Arabic milestones oldest first. It gives calendar days without times,
so scans retain their day and the page's order within that day. The warehouses receive the
parcel again in the customer's city after the sorting, and that receipt reads as transit.

Set `TAMEX_TRACKING_NUMBER` and optionally `TAMEX_UNKNOWN_NUMBER` outside the repository and run
`npm run test:carriers:live -- carriers/tamex`.
