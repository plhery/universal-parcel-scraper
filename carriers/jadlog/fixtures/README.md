# Jadlog fixtures

Every identifier, reference and timestamp is invented; `10089999999991` is a 14-digit number
that neither Jadlog's tracker nor Geopost's guest service knows.

The JSON files are Geopost guest-API `parcels/details` replies for the `JADLOG` business unit
without a postcode, in the shape of a live reply: the current status on `America/Sao_Paulo`,
one `parcelHistory` entry per milestone with a `-03:00` offset, no places, Jadlog's business
unit `060`, and an empty `receiver` block.

- `registered.json`: an order Jadlog has registered and not yet collected, as a live reply gave it.
- `delivered.json`: a parcel delivered to the recipient's address, its milestones in DPD's
  enumeration.

The HTML files are pages of Jadlog's tracker (`/jadlog/rastreio`) in the markup of a live one,
reduced to the echo of the number asked, the shipment's panel under an invented shipment id and
its rows, oldest first, in the tracker's own wording.

- `site-delivered.html`: a parcel the sender left at a Jadlog point, delivered.
- `site-transit.html`: a parcel Jadlog took in, on its way between units.
