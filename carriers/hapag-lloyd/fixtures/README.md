# Fixtures

Replies to the containers' lookup as the browser service passes them on, after
[its projection](../../../trawl/hapag-lloyd-browser.mjs) drops container types, weights and
voyages.

- `synthetic-container.json`: synthetic, in the shape of the public sample's reply. A container
  whose number fails its check digit, carried with a transshipment and returned empty.
- `synthetic-bill-two-containers.json`: synthetic. A bill from an office Hapag-Lloyd does not
  have, whose two containers' numbers fail their check digit: one returned empty, the other railed
  inland and out for delivery, its return still due.
- `not-found.json`: the reply to a container Hapag-Lloyd does not hold.

The public sample's own reply is another shipment than the one its source shows, so it is not kept.
