# APD

APD, or Adelaide Parcel Delivery, is South Australia's oldest parcel delivery company. From Dudley
Park in Adelaide it runs same-day couriers, overnight parcels, taxi trucks and freight. Its site is
apdparcel.com.au. Tracked through its own tracker.

## Numbers

Public examples are R, seven digits and a letter. The tracker checks the letter: with the right
one it answers for the label as R and its seven digits, and with a wrong one it finds nothing. It
also takes the seven digits without the letter. Only an aggregator's examples show the layout, so
there is no rule and the adapter answers an explicit selection. The tracker also takes ticket and
job numbers, which the adapter does not.

## Retrieval

1. `direct`: one form `POST https://online.apdparcel.com.au/track` with `fn=goto`,
   `page=tracking/brief` and `label={number}`, the fields the page's script posts. It needs no
   cookie, key, CAPTCHA or browser.
2. `retry`: one more request after a network failure or a timeout. The first gets half of the
   budget.

- The tracker runs on Hub Systems software and renders the label's history into the page as a
  `trackingData` object. A found label has `status` `success`; its `item` and every scan's must
  be the label asked without its letter.
- A label the tracker does not know, or with a wrong letter, answers `failed` with the reason
  `no history found` and the key it was given: that alone is not found. Another failure, or a
  page without the object, is a schema failure; a redirect or a 404 is a moved route and a 403 a
  refusal.

## Notes

- The scans run oldest first, each an action with its clock as `YYYYMMDDHHmmss` on Adelaide's
  wall clock, which the adapter reads on `Australia/Adelaide`. Descriptions are the page's own
  wording for its six actions, else the action's description; the action is the provider code.
- The page's summary has picked up, in depot, out for delivery, an attempted delivery and
  delivered. A driver's `accept` is out for delivery and `carriermanifest`, a handover to another
  carrier, in transit. Other actions keep their wording without a stage.
- The delivery's `signatureName` is the name taken with the signature. The driver's name, the
  scan's coordinates, the comments and the signature image are left out.

## Limitations

- No location, delivery estimate or service.

## Links

The tracker posts the number, so no address opens one parcel.

## Testing

`APD_TRACKING_NUMBER=… APD_UNKNOWN_NUMBER=… npm run test:carriers:live -- carriers/apd-parcel`
