# Lisa Parcel

Lisa Parcel collects parcels in southern California and forwards them by air
and sea to international destinations. Its public tracking form accepts the
Lisa Parcel number and related identifiers. The guest JSON reply has separate
fields for the primary, vendor and relay references. The adapter checks that
one matches the user's lookup before accepting the shipment.

The carrier's form publishes `CT312474908UZ`. The native reply confirms that
reference with US warehouse movements, air departure, postal handoffs and
final delivery. It displays the same clock on all thirty entries, across
multiple countries. The adapter keeps the reported dates and treats that
clock as display precision. It emits recognizable status events and facility
labels and skips administrative notices and location-only rows.

The example `M283452` returns the guest endpoint's typed no-record response.
The verified positive is a postal handoff identifier. Select Lisa Parcel
explicitly for this forwarder's tracking history.

- [Carrier guest tracker with the published examples](https://lisaparcel.com/en/track)
- [Lisa Parcel pickup and drop-off service](https://lisaparcel.com/en/send)

Run the guest checks with `LISA_PARCEL_TRACKING_NUMBER=CT312474908UZ
LISA_PARCEL_MISSING_NUMBER=M283452 npx vitest run --config
vitest.carriers-live.config.ts carriers/lisa-parcel/adapter.live.test.ts`.
