# Zippee

Zippee parcels use enabled universal providers. There is no dedicated adapter.

Zippee is an Indian quick-commerce delivery service. It runs dark stores and its own last-mile
fleets, which deliver consumer brands' and marketplaces' orders within 30 minutes or the same day.
Its site is zippee.delivery.

## Numbers

Its tracking page asks for an AWB number. No public page shows one, so its format is unknown and
there is no rule.

## Why there is no adapter

Its tracking page posts the AWB as `ref_code` to `api.zippee.delivery/api/1/track-order`, which
answers JSON events. No public number is known to see a found reply. A one-time code is needed only
to show the recipient's and rider's contact details.

## Links

`www.zippee.delivery/track-order?awb=<number>` opens one parcel.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
