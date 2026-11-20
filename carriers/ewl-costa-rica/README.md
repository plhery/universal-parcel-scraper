# EWL Costa Rica

Select EWL Costa Rica and enter the guide number from the shipping receipt.
[EWL's public tracking form](https://ewl-cr.com/#rastreo) looks up one guide
using that number alone.

The adapter reads the guest form's two HTML tables, checks the echoed guide
and uses the dated milestones for shipment status. Scans retain the local
clock shown in Costa Rica. Names, addresses and free-text observations are
omitted.

Set `EWL_COSTA_RICA_NUMBER` and run
`npm run test:carriers:live -- carriers/ewl-costa-rica` to verify a public sample.
