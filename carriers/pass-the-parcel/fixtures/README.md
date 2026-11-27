# Fixtures

`delivered.json` and `delayed.json` are the live replies of the Freightways `tracking-events`
lookup under Post Haste's name for two archived public codes in [numbers.json](../numbers.json),
oldest scan first as it lists them.

`delivered.json` is a parcel New Zealand Couriers picked up and Post Haste put out for delivery
and delivered, with a signature. `delayed.json` is a parcel Post Haste carried throughout, with
a transit delay notice between pickup and delivery and a delivery photo beside the signature.

Each attachment's description, the signatory's name, is replaced by `Signer`, and each of its
links by `https://example.invalid/attachment`. Everything else is as the lookup sent it.

An unknown code gets an empty HTTP 204 reply, so it has no fixture.
