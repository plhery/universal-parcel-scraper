# Noerpel

Noerpel parcels use enabled universal providers. There is no dedicated adapter.

Noerpel is an Ulm groupage and logistics group delivering across Germany and Austria. Its site is noerpel.de.

## Numbers

A review on Noerpel's Trustpilot page gives a nine-digit ID with the recipient's postcode; it is in
[`numbers.json`](numbers.json). The tracker's placeholder starts shipment numbers with 890. Nine bare
digits are printed by many carriers, so there is no rule.

## Why there is no adapter

Its tracker needs the recipient's postcode with the number. Its form sends one
`GET https://portal.noerpel.de/dw/request/tracking?data={kind};{number};{postcode}`, without a login or
CAPTCHA, where the kind is `SDG` for a shipment number, `REF` for a reference or `COL` for a parcel number.
The server renders the page, and an unknown pair gets `Zu Ihren Sendungsangaben konnte keine Sendung
gefunden werden.` The review's ID and postcode got that notice under each kind six months later, so no
reply for a known shipment has been seen. An adapter would also need the postcode as an input.

## Links

The tracker takes the number and postcode in a form, so no link names it.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
