# J&T Express

J&T parcels use enabled universal providers. There is no dedicated adapter.

## How it works

J&T operates country-specific tracking sites. The Philippines website's client names a
tracking endpoint and CAPTCHA flow, but its tracking route does not return a usable
anonymous history. A Philippines result would not establish support for other countries.

## Limitations

The catalog includes several national number formats. Numeric matches are ambiguous and
must not select a country or establish carrier ownership.

## Testing

Provider live-test inputs and commands are in the [provider READMEs](../../providers/README.md).
