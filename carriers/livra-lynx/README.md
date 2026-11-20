# Livra Lynx

Select Livra Lynx and enter a parcel number from the carrier. The
[Tunisian guest tracker](https://livra.tn/suivi/) submits the number as an
integer to its tracking API. The adapter checks the returned parcel number,
reads the current status and loads the timestamped timeline.

The adapter keeps the timestamp offsets and precision supplied by the carrier.
The governorate shown alongside the timeline is the parcel destination.

Set `LIVRA_LYNX_NUMBER` and run
`npm run test:carriers:live -- carriers/livra-lynx` to verify the sample.
