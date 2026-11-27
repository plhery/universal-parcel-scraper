# ExigentExpress

ExigentExpress shipments use enabled universal providers. There is no dedicated adapter.

ExigentExpress (Exigentexpress - Transportes) is an express courier in Albergaria-a-Velha,
Portugal, on the postal register of ANACOM, Portugal's communications regulator. Its site is a
tracking portal with a client login.

## Numbers

No public page shows one of its shipment numbers. The form's placeholder examples are the portal
software's, shared with its other carriers, so there is no rule.

## Why there is no adapter

Its tracking page is a GET form on the customer portal software that
[Intercourier](../inter-courier/README.md), [Transportes Rapex](../transportes-rapex/README.md) and
[Logisimple](../logisimple/README.md) also run on. Logisimple's reader takes a host, but each
carrier names its own states, and no found ExigentExpress page has been seen to map them.

## Links

`exigentexpress.pt/pt/tracking?tracking=<number>` (or `/en/tracking`) opens one shipment. The www host
answers 404, so only the bare host is read.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
