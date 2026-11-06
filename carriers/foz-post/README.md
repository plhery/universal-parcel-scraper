# Foz Post

Foz Post parcels use enabled universal providers. There is no dedicated adapter.

Foz Post (Fozpost - Entregas e Recolhas de Encomendas Lda) is a parcel pickup and delivery courier
in Pombal, Portugal. Its site, fozpost.com, is a tracking portal with a client login.

## Numbers

The public example is twelve digits. The form's placeholder examples are the portal software's,
shared with its other carriers. Twelve bare digits fit many carriers' numbers, so there is no rule.

## Why there is no adapter

Its tracking page is a GET form on the customer portal software that
[Intercourier](../inter-courier/README.md) and [Logisimple](../logisimple/README.md) also run on.
Logisimple's adapter reads that portal with its host passed in, but no found Foz Post page has been
seen to map its states.

## Links

`fozpost.com/pt/tracking?tracking=<number>` (or `/en/tracking`) opens one parcel. The www host
answers 404 on every page, so only the bare host is read.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
