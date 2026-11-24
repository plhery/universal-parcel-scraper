Replies of Pargo's `GET track.pargo.co.za/events/orders/{code}`.
`delivered.json` answers the public sample in [`numbers.json`](../numbers.json), a shop's
warehouse-to-door order, with the shop's support email and phone replaced by placeholders; its
recipient address carries only its type. `not-found.json` is the HTTP 422 answer for a synthetic
code of the same shape that the tracker holds no order for.
