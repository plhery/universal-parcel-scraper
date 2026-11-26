# Arriival

Arriival is a Malaysian booking platform. Its own air freight from Peninsular to East Malaysia
travels under its waybills, which its tracker at `arriival.com/tracking` takes. A service it
resells from another courier carries that courier's number.

## How it works

1. `direct`: posts to `uml.arriival.com/qmcs-u-api/order/getOrderTracking?no=<number>`, with no
   body, as the tracking page does. The reply's `code` 301, "Tracking Number does not exist", is
   its answer for a number it holds no waybill under, and reads as not found.
2. `retry`: a read that fails to reach the tracker, or hangs, is sent once more.

- The lookup asks for no session or check.
- Code 407, "Operation failed", answers a request the tracker could not read, such as one without
  a number or sent as GET, so it says nothing about the waybill. The page's script reads it as not
  found too; the adapter does not.
- The reply must name the number as its own.

## Notes

- Scans carry a wall clock with no zone and keep it.
- The tracker's scan codes rise with the waybill's progress. Its page drops repeated scans and
  lists the newest first, the higher code first within a second; the adapter does the same.
- The out-for-delivery scan gives the driver's phone in a sentence of its own, which the adapter
  leaves out. The sender, the recipient, the delivery address and the proof-of-delivery photo stay
  behind. So do the origin and destination towns, which have no result field.
- The service is the reply's delivery type, such as the WM–EM freight.

## Limitations

- Scans name no place, and the tracker gives no delivery estimate.

## Numbers

The public sample is `TH`, nine digits and `AF`. It and its source are in
[`numbers.json`](numbers.json).

## Testing

`npm run test:carriers:live -- carriers/arriival`

The live test tracks the public sample in `numbers.json`; `ARRIIVAL_TRACKING_NUMBER` tracks another
number, and `ARRIIVAL_UNKNOWN_NUMBER` checks the not-found answer.
