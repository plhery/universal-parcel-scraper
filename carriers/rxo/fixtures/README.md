# Fixtures

Replies of `GET clm.rxo.com/trackapi/orders/trackbillto/<number>?billTo=0`, the lookup RXO's
tracking page makes, with the page's free texts emptied and the retailer's reference replaced by a
placeholder. Coordinates and addresses in them are RXO's hubs.

- `delivered.json`: the reply for the first public sample in [`numbers.json`](../numbers.json), a
  delivery rescheduled en route and then delivered.
- `installed.json`: the reply for the second public sample, two deliveries and two installation
  visits, the first of each not performed.
- `returned.json`: the reply for the third public sample, a return pickup rescheduled en route and
  then collected and brought back to the facility.
- `not-found.json`: the reply, with HTTP 200, for an invented number.
