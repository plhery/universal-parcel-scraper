# Fixtures

Replies of Délivro's tracker on Dispatch Science, `delivro.dsapp.io/api/v1/orders/tracking/{number}`, asked in
English as the tracking page asks.

- `delivered.json`: the reply for the public sample in `numbers.json`, an order picked up, put on hold, released and
  delivered. The pickup and drop-off towns are replaced with placeholders. The support line under the hold is
  Délivro's own, as its site gives it; the reply names no person and shows no map position or signature.
- `not-found.json`: the reply, with HTTP 404 and the `application/problem+json` type, for a synthetic order id of
  the sample's shape that the tracker does not know.
