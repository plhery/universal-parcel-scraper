# GOFO France

Tracks the French GOFO network, including its CIRRO Parcel waybills, through
the official anonymous JSON service. Other GOFO national services have separate
carrier ids.

## How it works

One bounded `POST /fr/open-api/official/track/queryTrackV2` submits `numberList`
with the French `lang` header, as the official
[tracking client](https://www.gofo.com/fr/tracking-results/) does. No token,
session or browser is needed. HTTP recognition uses the same identity checks.

The whole requested identifier must match `trackingNumber` or `waybillNo` in one
record. Its national waybill and destination must establish French scope.
The [customer support page](https://www.gofo.com/fr/contact-us/) describes the
national identifier families. The supported shipper reference needs its printed
hyphens restored after package normalization; an unpunctuated request returns
no history.

## Notes

The latest summary must match the first scan. The client renders the list in
its returned order; equal and unresolved clocks keep that order. Explicit
offsets are preserved, and offset-free clocks remain local. A larger event
counter or the output cap marks history incomplete so enabled providers can
complete it.

Stages follow operation codes, with explicit failed-delivery wording refining
the alert category to a failed attempt. Delivery requires affirmative wording.
Preparing a parcel does not mean the carrier has received it. A return to the
sorting centre after a delivery problem is an exception; the client's return
category establishes a return to the sender. The service name is retained as
the carrier supplies it.

## Limitations

Empty results remain inconclusive. Proof images, recipient verification,
detailed delivery prose and unrelated references are excluded. Weight has no
verified unit, and estimates have no verified active-parcel provenance.

## Live test

Set `GOFO_FR_TRACKING_NUMBER` outside Git and run
`npm run test:carriers:live -- carriers/gofo-fr/adapter.live.test.ts`.
Optionally set `GOFO_FR_UNKNOWN_NUMBER` to check an inconclusive empty response.
