# Wise Express

Wise Express parcels use enabled universal providers. There is no dedicated adapter.

Wise Express is a Shanghai cross-border logistics company, founded in 2002, that collects sellers' parcels
for Wish Post and other lines. It is not WanB Express.

## Numbers

No public page shows a Wise Express number, and many of its parcels carry a partner's number, so there is no
rule.

## Why there is no adapter

The tracker's slider CAPTCHA is checked only in the page: `set_code.asp` keeps the page's random key in a
cookie, and `track.asp` then answers the numbers posted with that key, as an HTML fragment after `0|`. No
public number has shown a known parcel's reply, so a found reply has not been seen.

## Links

Its tracker has no address for a single number, so no link names it.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
