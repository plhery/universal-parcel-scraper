# Fixtures

Pages of `POST my.ediexpressinc.com/prodetail.asp`, the shipment page EDI Express's trace form posts a
PRO number to, trimmed to the shipment details, with the ZIP codes replaced by `00000`.

- `delivered.html`: the page for the public sample in [`numbers.json`](../numbers.json), delivered
  freight with its pickup, dispatch and delivery days.
- `not-found.html`: the page for an invented PRO number.
