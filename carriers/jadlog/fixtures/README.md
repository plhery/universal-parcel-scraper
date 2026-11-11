# Jadlog fixtures

Every identifier, reference and timestamp is invented; `10000000000001` is a 14-digit number
that was never issued. Each file is a Geopost guest-API `parcels/details` reply for the
`JADLOG` business unit without a postcode, in the shape of a live reply: the current status on
`America/Sao_Paulo`, one `parcelHistory` entry per milestone with a `-03:00` offset, no places,
Jadlog's business unit `060`, and an empty `receiver` block.

- `registered.json`: an order Jadlog has registered and not yet collected, as a live reply gave it.
- `delivered.json`: a parcel delivered to the recipient's address, its milestones in DPD's
  enumeration.
