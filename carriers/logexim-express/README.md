# Logexim Express

Logexim Express moves freight across Kazakhstan. Its [guest tracker](https://www.logeximexpress.kz/nayti-posylku)
accepts a numeric waybill.

The adapter opens a fresh tracking form to obtain its anonymous session cookie and CSRF
field, then sends the waybill to `POST /ajax/trackInvoice`. The waybill in the response must
match the lookup. The cookie and token belong to one attempt.

The tracker reports creation and actual delivery dates alongside undated
administrative steps. The adapter reads dated steps at the precision the
carrier reports and uses the actual delivery date when available.

Set `LOGEXIM_EXPRESS_NUMBER` and run
`npm run test:carriers:live -- carriers/logexim-express` to verify a sample.
