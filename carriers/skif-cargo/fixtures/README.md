# Fixtures

Replies of the tracker's lookup, `POST /tracking/`.

`issued.json` and `issued-same-day.json` are the whole replies for the two public samples in
[`numbers.json`](../numbers.json), in that order: the application with its state, issue time,
parties, cargo and price, and the route's points, all reached. In the second, the collection
and the first warehouse fall on one day.

`not-found.json` is the reply for a number the tracker does not know.
