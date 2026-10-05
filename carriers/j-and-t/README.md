# J&T Express

J&T parcels use enabled universal providers. There is no dedicated adapter.

## How it works

J&T operates country-specific tracking sites. The Philippines website's client names a
tracking endpoint and CAPTCHA flow, but its tracking route does not return a usable
anonymous history. A Philippines result would not establish support for other countries.

The Indonesian site asks for the last four digits of the sender's or recipient's phone
number before it looks a waybill up, so a number alone cannot be checked there.
[J&T Cargo](../j-and-t-cargo/README.md) is a separate Indonesian network with its own site,
the same prompt and its own carrier id.

## Limitations

The catalog includes several national number formats. Numeric matches are ambiguous and
must not select a country or establish carrier ownership. J&T Indonesia's help centre says
its waybills usually start with two letters, such as `JO` or `JP`; the prefixes with enough
public reports select J&T, and the others only suggest it.

## Testing

Provider live-test inputs and commands are in the [provider READMEs](../../providers/README.md).
