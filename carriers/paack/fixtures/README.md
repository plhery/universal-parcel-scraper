# Paack fixtures

- `delivered-order.json`: `routes/tracking.order` loader payload for a delivered order with
  an earlier incorrect-address attempt and a delivery window. Built around the order number
  from Paack's public API examples; every retailer, recipient, contact, address and
  `variables` field is a `PRIVATE …` placeholder so the test can assert none leaks.
- `label-barcode-order.json`: the same loader for an order looked up by its label barcode,
  with the structure of a live reply. `external_id` is the retailer's own reference, not the
  barcode, and the timeline lists the steps still to come without a timestamp. Times and the
  delivery postcode are synthetic; retailer and order references are `PRIVATE …`
  placeholders.
