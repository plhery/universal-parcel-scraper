# Pointpack

Pointpack parcels use enabled universal providers. There is no dedicated adapter.

Pointpack is a network of parcel points in shops and petrol stations in Poland. Parcels sent from a
point travel with DHL or Poczta Polska, and its tracking page shows their scans beside its own. Its
site is pointpack.pl.

## Numbers

Its complaint form checks a Pointpack id as 10 digits, or S or PX and 10 digits. No public page
shows a whole number, so there is no rule.

## Why there is no adapter

Its tracking page finds a parcel by the id sent by SMS or email and shows its point events with the
partner's delivery attempts, notices and pickup point. With no public number to check its replies
against, there is no adapter.

## Links

The tracking page opens a number from its path, as in `/sledz-przesylke/`.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
