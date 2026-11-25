# Fixtures

Replies of `POST barqfleet.com/graphql/` to the tracking page's `OrderTracking` query, asked without the
merchant's details and the coordinates.

- `completed.json`: the reply for the public sample in [`numbers.json`](../numbers.json), a delivered order
  with its four logs.
- `not-found.json`: the reply, with HTTP 200, for an invented number.
