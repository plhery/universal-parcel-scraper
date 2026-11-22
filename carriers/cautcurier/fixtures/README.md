# Fixtures

CautCurier's order lookup, as the tracking page calls it:

- `cancelled.json`: the reply for `489581`, the AWB the tracking page's script keys a sample
  timeline to, an order created and then cancelled by CautCurier's office. The masked sender and
  recipient are replaced with placeholders.
- `not-found.json`: the HTTP 500 body for `489599999`, past the order ids in use, which the
  lookup has no order for.
