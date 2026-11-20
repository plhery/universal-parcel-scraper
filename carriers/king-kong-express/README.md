# King Kong Express

Select King Kong Express to track a ten-digit waybill through its public tracking form.
The form posts one waybill to the carrier and returns that lookup's scan list without echoing
the number. All-zero input is rejected because the upstream returns unrelated history for it.

The adapter keeps the reported scan clocks as local time. It reads the station from the scan
text and omits contact and transfer details.

Set `KING_KONG_EXPRESS_TRACKING_NUMBER` and run
`npm run test:carriers:live -- carriers/king-kong-express`.
