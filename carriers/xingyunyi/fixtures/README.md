# XingYunYi fixtures

Replies of the tracking page's `GetTracking` call. The replies hold no recipient details.

- `in-transit.json`: the reply for the first public sample in [`numbers.json`](../numbers.json), a parcel
  from Guangzhou to the United Kingdom, last released from customs there. The lookup also asked the
  number without its last two letters; that entry is removed.
- `delivered.json`: the reply for the second public sample, an order to Australia the page calls
  delivered. Its one row is the line's tracker no longer finding the line's number, dated when the page
  asked.
- `not-found.json`: the reply for an invented number, an empty order with the id 0.
