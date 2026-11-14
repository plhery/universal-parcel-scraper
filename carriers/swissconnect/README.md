# swissconnect

swissconnect parcels use enabled universal providers. There is no dedicated adapter.

swissconnect, swissconnect ag of Lucerne, runs a network of more than 80 Swiss express courier
firms. Its member firms carry shipments by bicycle, train and car, and its own software routes
them.

## Numbers

Its tracker finds a shipment by its shipment number. The form's placeholder reads as three
digits, a hyphen, a digit, a letter and five digits, but no public page shows a real number, so
there is no rule.

## Why there is no adapter

A "Sendung verfolgen" button on every page of swissconnect.ch opens the tracker in a pop-up. Its
script posts the number to swissconnect's JSON service and shows whether the shipment is being
prepared, picked up, out for delivery or delivered, with the pickup and delivery windows and,
once delivered, the time and the name of whoever took it. With no public number to check its
replies against, there is no adapter.

## Leads

The tracker sends `POST /api/track-shipment` with the number as JSON `trackingId`. A number that
matches more than one shipment gets an error that asks the reader to call swissconnect. The
tracker's container has a `data-tracking-number` attribute that the server fills; when it holds
a number, the page opens the tracker and submits it. No address that fills it is known.

## Links

Its tracker takes numbers only through its pop-up form, so no address opens one shipment.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
