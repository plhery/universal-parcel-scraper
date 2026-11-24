# Fixtures

Replies of `GET app.recibelo.cl/api/check-package-internal-id?internal_ids[]=<number>`, the lookup
Recíbelo's tracking page makes, with the recipient's name replaced.

- `completed.json`: the reply for the first public sample in [`numbers.json`](../numbers.json), a
  delivered parcel after a failed delivery.
- `created.json`: the reply for the second public sample, a parcel the shop created.
- `not-found.json`: the reply, with HTTP 404, for an invented number.
