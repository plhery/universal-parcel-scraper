# Islandwide Express

Islandwide Express (PJ Rosaly Enterprises) is a Puerto Rico courier with terminals across the
island. The tracking page on islandwide.com frames its tracker, an OutSystems app on
`preidi.outsystemsenterprise.com`.

## How it works

1. `direct`: `POST https://preidi.outsystemsenterprise.com/tracking/screenservices/Tracking/ActionGetInformationbyTracking`,
   the action the tracker's page calls when it opens with a number. The body names the app's
   build, as the page does, and the number. Before its first lookup the tracker reads the build
   from `moduleservices/moduleversioninfo`, then the action's version from the controller script
   the module's manifest lists.
2. `retry`: once more after a network failure or a timeout.

- The request carries the `X-CSRFToken` that OutSystems gives every anonymous visitor, with no
  cookie or session.
- After a deploy the action answers that the build changed. The tracker reads the versions
  again and asks once more; a second such answer is a schema error.
- The only not-found answer is the action's empty shipment list. A shipment under another number,
  an OutSystems error, a page in place of JSON and HTTP errors are not missing shipments.
- The shape the tracker's list of formats gives as Islandwide's own, nine digits, six letters
  and seven digits, offers Islandwide, and recognition asks it.

## Notes

- Clocks are a day and a time to the second with no zone. Islandwide's terminals are all in
  Puerto Rico, so each clock keeps its wall clock and is dated on Puerto Rico's clock, marked as
  the carrier's zone.
- The shipment's state id is the current state. A scan's state id gives its stage, and the
  tracker's label for it is the wording. A row relayed from another carrier has that carrier's
  description, which replaces the label.
- A scan's place is the terminal it names. The page places a pickup at the sender's address and a
  delivery at the recipient's, so those rows have no place.
- Before delivery the page shows a delivery window, which becomes the expected delivery. After it,
  the delivery time is read.
- The delivery and pickup addresses, the signer's name, the signature, the scans' coordinates and
  the driver's and user's ids are not read.

## Limitations

- Only a delivered shipment has been seen. The stages of states it did not reach come from the
  page's image for each state, and the label a scan in those states carries is unknown.
- The page also shows a shipment whose earlier number, which the reply gives beside its own, is
  the number asked. The adapter takes only a shipment whose own number is the one asked, so such
  a lookup is inconclusive.
- The page's "Time Estimated" line is empty for the shipment seen and is not read.

## Numbers

The tracker's list of formats runs from eight to 34 letters and digits, among them its customers'
labels and other carriers' numbers it delivers. The public sample is nine digits, six letters and
seven digits.

## Links

`www.islandwide.com/tracking?TrackingNumber={number}` opens one shipment on the tracker, and the
library reads the number from `TrackingNumber`.

## Testing

`npm run test:carriers:live -- carriers/islandwide-express`, with
`ISLANDWIDE_EXPRESS_TRACKING_NUMBER` and `ISLANDWIDE_EXPRESS_UNKNOWN_NUMBER` optionally set.
