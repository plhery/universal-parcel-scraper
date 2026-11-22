# Courier IT

Courier IT is a South African courier. It carried [PostNet](../postnet-za/README.md)'s counter-to-counter
waybills before Aramex, and PostNet still sends parcels with it.

## Numbers

Its waybills are a few letters and digits, such as a customer prefix and nine digits. Older PostNet waybills it
carried are PN or PP and seven digits. The shapes are too generic to claim, so no rule suggests Courier IT.

## Retrieval

Courier IT's tracker, `intellitrack.courierit.co.za`, is a Blazor Server app. Its lookup runs over the page's live
connection to the server, and no separate request answers it. For a number it does not know it says it has no
record of the parcel yet, which does not say that the number is wrong.

Its booking portal, `sendit.courierit.co.za`, runs on Ship Logic, as [Internet Express](../internet-express/README.md)
does: `GET https://api.sendit.courierit.co.za/tracking/shipments` with `tracking_reference` and provider id `210`.
It knows only the shipments booked on that portal and answers HTTP 404 for the others, including the public
samples.

PostNet's tracker asks Courier IT's system for a waybill when it looks one up, and shows Courier IT's events for
any of its waybills. The adapter makes PostNet's lookup for Courier IT's network alone, with the token and the
session cookie PostNet's tracker page gives; see PostNet's README. An empty answer is a missing waybill.

## Events

Each event is a name, a detail after a dash, a branch code and a day and time to the minute. The details name the
sender, the driver and the route, who signed, and staff comments, so only the name is kept and comments are left
out. Times are read on South Africa's clock, UTC+2 all year.

Courier IT captures a waybill's details after it takes the parcel; that event does not set the parcel back. A
parcel a round does not deliver goes back to the branch's cage and out again.

## Limitations

The empty answer that tells a waybill is missing is the same as a lookup that failed to answer, which PostNet's
tracker does not tell apart. There is no delivery estimate, weight or service.

## Links

The tracker takes the number as `SearchString`. Older links point to `courierit.co.za/Trackit/Trackit.aspx` with
`WaybillNumber`.

## Testing

```sh
COURIER_IT_TRACKING_NUMBER=<public sample> COURIER_IT_UNKNOWN_NUMBER=CDM999999990 \
  npm run test:carriers:live -- carriers/courier-it
```
