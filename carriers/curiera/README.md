# Curiera

Curiera parcels use enabled universal providers. There is no dedicated adapter.

Curiera delivers parcels in Bucharest and Ilfov with electric vehicles, and across Romania through
partners. Its site is curiera.ro.

## Numbers

No public page shows a Curiera number or its layout, so there is no rule.

## Why there is no adapter

Its tracking page, hosted on CourierManager, a courier software platform, takes an AWB in its
address or through a form and shows its scans. With no public number to check its replies
against, there is no adapter.

## Links

The tracking page opens an AWB from its `awbno` parameter. Its host also serves the other
CourierManager couriers, chosen by `appcont`, and shows Curiera's page when the parameter is
absent. The library reads addresses on it with Curiera's `appcont=4416` or none, and those
with `appcont=4416` on CourierManager's shared host.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
