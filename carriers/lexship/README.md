# LEXSHIP

LEXSHIP parcels use enabled universal providers. There is no dedicated adapter.

LEXSHIP is a cross-border export service of LogiLink India Pvt Ltd in Bengaluru. It consolidates
shipments from Indian small businesses and marketplace sellers and sends them abroad through
partner carriers, under its own shipment numbers. Its site is lexship.com.

## Numbers

No public page shows a LEXSHIP number and their format is unknown, so there is no rule.

## Why there is no adapter

Its tracking page at track.lexship.biz is a JavaScript app that posts the number to
`live1.lexship.com/api/tracking/new`. The API needs a bearer token that the page's script carries,
the same for every visitor. No public number is known to see a found reply.

## Links

`track.lexship.biz/?tracking=<number>` opens one shipment.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
