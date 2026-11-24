# Fixtures

Replies of `GET track.trusk.com/api/order/<order>`, the read Trusk's order page makes, with the
recipient's masked name, phone and address, the retailer's order number and Trusk's delivery ids
replaced by placeholders.

- `delivered.json`: the reply for the first public sample in [`numbers.json`](../numbers.json), a
  delivered order whose earlier steps keep no time.
- `delivered-archived.json`: the archived reply for the second public sample, with the time of
  each step.
- `awaiting-slot.json`: the reply for the third public sample, an order whose recipient has a
  delivery slot to choose.
- `not-found.json`: the reply, with HTTP 404, for an invented order id.
