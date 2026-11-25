# ASL Track

ASL Track gives merchants' US shipments an `ASL` number of its own and shows the scans of the
carrier that moves each one, without naming that carrier. Its public API answers the number.

## How it works

1. `direct`: asks `asltrack.com/api/v1/track/{number}`, the API its documentation gives for
   integrations. It needs no key or session; a partner key only lifts the rate limit. HTTP 404
   with `found: false` is not found, the same answer the API gives a malformed number.
2. `retry`: a read that fails to reach the API, or hangs, is sent once more.

- The answer must name the number asked.

## Notes

- Every time comes labelled UTC, but ASL Track stores the carrier's wall clock, which comes
  without a zone, as given: its own tracking page says so and shows the digits unconverted. The
  digits are therefore read as the scan place's wall clock. A time with a fraction of a second is
  ASL Track's own stamp and is kept as an instant.
- Detection suggests ASL Track for `ASL` and eleven digits whose last is a Luhn check over the
  ten before it, the format the documentation gives. The adapter refuses a number that fails the
  check before asking, since the API answers it as it answers an unknown number.
- The delivery time repeats the delivered scan's wall clock, so only the scan keeps it. The origin
  and destination towns stay behind.

## Limitations

- The scans do not name the carrier that moves the shipment or its number.
- The delivery estimate is not read; when the reply fills it, the result names it as unread.
- The API sends the fifty newest scans.

## Testing

`npm run test:carriers:live -- carriers/asl-track`

The live test tracks the example in `numbers.json`; `ASL_TRACK_TRACKING_NUMBER` tracks another
number, and `ASL_TRACK_UNKNOWN_NUMBER` checks the not-found answer.
