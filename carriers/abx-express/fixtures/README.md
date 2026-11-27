# Fixtures

- `delivered.html`: the result page for the public sample in `numbers.json`, cut to its header and result
  section. The four delivery photos, embedded as data URIs, are cut to one empty slot, and the hidden inputs
  that held the delivery photo link and the sender's and recipient's phone numbers are removed.
- `not-found.html`: the result page for an invented number far from the sample's range, cut the same way. Its
  one row is dated at the moment of the lookup.
- `form.html`: the tracking page's form, with a synthetic token in place of the visitor's.
