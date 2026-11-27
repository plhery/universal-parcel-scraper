# Primetime Express

Primetime Express is a Cape Town courier and freight company with door-to-door courier and road
freight across South Africa, cross-border road freight and international courier and airfreight. Its
site is ptexpress.co.za. It tracks waybills through its
[ParcelPerfect tracker](https://primetimeexpress.pperfect.com/).

## How it works

1. `direct`: the adapter reads the public tenant code from `config/config.json` and asks the
   tenant's `Waybill.getEventData` service for one waybill, as the tracker does. Every visible scan
   must name that waybill. Clocks have no offset and are kept as local time.

[Bigfoot Express Freight](../bigfoot-express/README.md) and
[Intertown Transport](../intertown-transport/README.md) run the same tracker client, so the
adapters share `parcelPerfect.ts` and its reading of stages. The only not-found answer is the
service's own "Event data not found." for the waybill; any other error, a page or an incomplete
reply is a failure.

## Notes

- No reply for a Primetime Express shipment has been seen. The parser, the found fixture and the
  wordings in `statuses.json` come from the ParcelPerfect replies of the other two tenants; a
  wording none of them recorded goes to the shared rules.
- The tracker sends what is typed, upper-cased, with no mask, and no public page shows a waybill.
  The adapter takes five to twenty letters and digits. There is no detection rule, so the carrier
  is asked only when it is selected or a link names it.
- The all-zero value answers the not-found reply here, so it is not excluded as it is for
  Intertown Transport.
- `primetimeexpress.pperfect.com/?w=<waybill>` opens one waybill: the page stores the number and
  moves to its waybill view, whose address no longer holds it.

## Limitations

- Only the waybill number is asked. The parcel's own tracking sticker number is a separate search
  on the tracker and is not read.
- The recipient's name, the proof-of-delivery image, the service, the piece count and the
  references that the tracker's waybill view shows are not read.

## Testing

Set `PRIMETIME_EXPRESS_TRACKING_NUMBER` and optionally `PRIMETIME_EXPRESS_UNKNOWN_NUMBER` outside
the repository and run `npm run test:carriers:live -- carriers/primetime-express`.
