# ShipGlobal India

ShipGlobal India parcels use enabled universal providers. There is no dedicated adapter.

ShipGlobal is a New Delhi cross-border shipping service exporting Indian sellers' parcels and handing them to
a delivery carrier abroad. Its site is shipglobal.in.

## Numbers

Its numbers are `SG3`, the booking date as YYMMDD and seven digits, which `shipglobal-in-1` suggests at low
confidence; archived lookups on its own tracker and a review show them, and its tracker finds them. The
delivery carrier's number stays with that carrier.

## Why there is no adapter

Its tracking page reads an open JSON API without a session or CAPTCHA, which answers an unknown number with
an explicit not-found. Its replies carry sender and recipient details an adapter would have to drop.

## Links

The tracking page opens numbers from its `awb` parameter.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
