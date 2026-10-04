# Fixtures

- `delivered.json`: a completed `tracking-request` payload (booking, dispatch and delivery rows) plus recipient remark, address and contact fields that must not survive normalization. Each row's `pincode_info` is a different case for the office point: another office's entry, a verified entry for the scan's office, and an unverified one.
- `export-customs.json`: code-only rows (`ITEM_BOOK` to `TRANSFER_OOE`) through export customs to the office of exchange, with a cached `synced_at`.
- `flight-legs.json`: two office rows, then a take-off at an Indian airport and one at a foreign airport, each labelled `Z` with the airport's wall clock. The newest label is later than `synced_at`.

All identifiers, offices, pincodes, times and recipient fields are made up.
