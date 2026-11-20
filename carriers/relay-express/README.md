# Relay Express

Select Relay Express to track an Indian freight docket. The public guest form requests one
docket's journey as an HTML fragment. Its empty CAPTCHA fields follow the form. A proof label
can confirm the docket number when present. The adapter leaves the attachment unopened.

The journey shows local scan clocks and facility names. The adapter skips the undated
proof label and keeps the dated delivery event.

Set `RELAY_EXPRESS_TRACKING_NUMBER` and run
`npm run test:carriers:live -- carriers/relay-express`.
