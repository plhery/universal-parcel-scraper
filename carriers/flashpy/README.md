# Flashpy

Flashpy forwards parcels collected in the United States to destinations in
Latin America. The Colombian public guest form submits the tracking reference
in its `code` query parameter. The adapter checks the guide in the returned
shipment card before reading its current state and timeline.

The carrier's documentation shows `TBA331695990904` as a lookup example.
Submitting that reference to the guest form returns the exact guide and four
distinct dated registration and international processing movements. The
adapter retains local minute precision. It skips repeat rows, the
percent-complete graphic and fields outside the movement list.

The sample is a marketplace reference the forwarder accepts. Select Flashpy
explicitly to see its forwarding movements. The app’s parcel link resolver
uses Amazon for this reference. Flashpy’s own numbered page opens directly.
A public reference producing an explicit no-record response has yet to be
verified.

- [Flashpy public tracking and integration example](https://www.flashpy.com/co/tracking)

Run the guest check with `FLASHPY_TRACKING_NUMBER=TBA331695990904 npx vitest run
--config vitest.carriers-live.config.ts carriers/flashpy/adapter.live.test.ts`.
