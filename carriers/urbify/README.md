# Urbify

Urbify shipments use enabled universal providers. There is no dedicated adapter.

Urbify, from Berlin, delivers online shops', meal-kit and grocery orders the same or the next day from its own hubs
in Germany and Austria.

## Numbers

The homepage's form and its example disagree on the reference's shape, and no public page shows one, so there is no
rule.

## Why there is no adapter

A lookup by reference also needs the recipient's postcode (`POST https://service.urbify.com/api/v1/tracking/track`).
With no public number to check the tracker's replies against, there is no adapter.

## Links

The homepage's form opens `tracking.urbify.com/<reference>`, which then asks for the postcode. The personal links
Urbify sends recipients carry a token in the same place, so no link rule reads a number from that address.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
