# TrumpCard

TrumpCard parcels use enabled universal providers. There is no dedicated adapter.

TrumpCard is an expedited air freight carrier in Carlsbad, California, and part of Imperative
Logistics Group. It moves mission-critical domestic freight, US-Mexico cross-border shipments and
fine art. Its site is trumpcardinc.com.

## Numbers

Shipments are looked up by airbill number or by reference or PO number. No public page shows a
TrumpCard airbill number, so there is no rule.

## Why there is no adapter

Its lookup at `ace2.trumpcardinc.com` is a Blazor app that renders the result in the browser. No
public number is known to see a found reply.

## Links

`ace2.trumpcardinc.com/searchairbill?SearchByAirbill=<number>` opens one shipment.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
