# Schneider

Schneider shipments use enabled universal providers. There is no dedicated adapter.

Schneider National, based in Green Bay, Wisconsin, carries truckload, intermodal and bulk freight
across North America and brokers loads. Its site is schneider.com.

## Numbers

Schneider publishes no load or shipment number format, and no public page shows one of its
numbers, so there is no rule.

## Why there is no adapter

Its track page reads tracking IDs in a form rendered in the browser and has its server verify a
reCAPTCHA v3 token, with a v2 checkbox after a low score, before it asks for the shipments. The
request it then sends,
`ui-api.schneider.com/tracking?pageNumber=1&pageSize=500&sort=UID.Key&desc=asc&references=<IDs>`,
answers JSON without the token, a login or a cookie. An ID it does not hold gets an empty
`shipmentInformation` list, which proves nothing. No public ID is known to check a found reply
with.

## Links

The track page looks up the IDs in its `tracking` parameter without the reCAPTCHA, but no public
ID is known to test such a link with, so none is recorded.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
