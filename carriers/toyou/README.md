# toyou

toyou parcels use enabled universal providers. There is no dedicated adapter.

toyou is Asda's parcel collection and returns network, run through Asda stores and petrol
station kiosks in Great Britain; the retailer's own carrier usually does the trunk leg. Its site
is toyou.co.uk.

## Numbers

Its parcel IDs are a four-letter retailer code and nine digits, the layout of Sunyou, BYHD and
Z-Leading numbers, so there is no rule.

## Why there is no adapter

The site sits behind a Cloudflare bot check, and its parcel API needs a short-lived token the
page gives each visitor, so an adapter would need a browser helper.

## Links

The track page opens a parcel ID from its path.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
