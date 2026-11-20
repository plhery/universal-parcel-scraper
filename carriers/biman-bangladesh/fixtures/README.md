# Fixtures

Replies to the tracker's lookup as the browser service passes them on, after
[its projection](../../../trawl/freight-aero-browser.mjs) drops weights and the reply's other fields.

- `awb-99767220602.json`: the public sample in `numbers.json`, a consolidated shipment from Dhaka
  booked on three flights and delivered in three parts at Toronto.
- `not-found.json`: synthetic, in the shape of the answer for a waybill the tracker does not hold.
  Its serial fails the check digit.
