# Transportes Rapex

Transportes Rapex parcels use enabled universal providers. There is no dedicated adapter.

Transportes Rapex is an urgent courier and messenger service in Seixal and Lisbon, with next-day
parcels across Iberia and pickups from Europe. Its site is transportes-rapex.pt.

## Numbers

The public example is twelve digits. The form's placeholder examples are the portal software's,
shared with its other carriers. Twelve bare digits fit many carriers' numbers, so there is no rule.

## Why there is no adapter

Its tracking page is a GET form on the customer portal software that
[Intercourier](../inter-courier/README.md), [Logisimple](../logisimple/README.md) and
[Foz Post](../foz-post/README.md) also run on. Logisimple's adapter reads that portal with its host
passed in, but no found Transportes Rapex page has been seen to map its states.

## Links

`transportes-rapex.pt/pt/tracking?tracking=<number>` (or `/en/tracking`) opens one parcel. The www
host answers 404 on every page, so only the bare host is read.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
