Replies of IQ Fulfillment's `POST https://iqintegrate.com/v1/tracking/history`, whole and
unchanged. `delivered.json`, `cancelled.json` and `not-delivered.json` answer public samples in
[`numbers.json`](../numbers.json). `not-found.json` is the HTTP 404 answer for an invented
reference, and `invalid-domain.json` the HTTP 404 answer to a request without the tracking page's
origin. The tests derive their other replies from the delivered one under an invented reference.
