# Fixtures

Replies of `GET aqxlogistics.com/api/track?id=<number>`, the lookup AQX's tracking page reads, with the
recipient's masked name and the destination town replaced by placeholders.

- `delivered.json`: the reply for the first public sample in [`numbers.json`](../numbers.json), a delivered
  shipment with only its registration event.
- `label.json`: the reply for the second public sample, a paid shipment with its label and registration events.
- `not-found.json`: the reply, with HTTP 404, for an invented number.
