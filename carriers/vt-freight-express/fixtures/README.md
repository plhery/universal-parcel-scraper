# Fixtures

Cut-down pages of VT Freight Express's tracker at `/Track/VTFE/{number}`, without their scripts,
maps and analytics.

- `delivered.html`: the page for the public sample in `numbers.json`, a consignment scanned into
  one depot, loaded at another and delivered. Grouped scan rows carry their scans' UTC ticks in
  the address of their detail panel; the delivery row has its clock and zone. The receiver's
  suburb, postcode and name are replaced with placeholders.
- `not-found.html`: the empty form with "Missing or incorrect tracking number", the tracker's
  answer for a synthetic number of the sample's shape. The form's id repeats that number.
