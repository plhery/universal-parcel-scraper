# Jumppoint International Express

Jumppoint International Express parcels use enabled universal providers. There is no dedicated
adapter.

Jumppoint International Express is the cross-border service of Jumppoint, a Hong Kong delivery
company. Its parcels track on their own site, apart from [Jumppoint](../jumppoint/README.md)'s
domestic waybills.

## Numbers

The international tracker on `int-tracking.jumppoint.io` accepts `JP`, two letters and ten
digits, besides the domestic `JP` and twelve digits. `jumppoint-international-1` claims the
international layout, which no other carrier's rule reads. ParcelPanel's Jumppoint page offers
one as a sample.

## Notes

- The tracker's lookup, `GET https://int-tracking-api.jumppoint.io/shipment/tracking/`, refuses
  a request without the page's reCAPTCHA token, so there is no adapter.
- Providers name the service by the domestic network's name, "Jumppoint". Jumppoint is a
  network brand, so for a number of this layout the name points here.

## Links

The tracker reads the numbers to show from `q`, so `int-tracking.jumppoint.io/?q={number}` opens
one parcel.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
