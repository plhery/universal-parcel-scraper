# Sinapseria

Sinapseria parcels use enabled universal providers. There is no dedicated adapter.

Sinapseria is a bicycle courier in Bucharest. Its site is sinapseria.ro.

## Numbers

No public page shows a Sinapseria number or its layout, so there is no rule.

## Why there is no adapter

Its tracking page, hosted on CourierManager, a courier software platform, takes an AWB in its
address or through a form and shows its scans. With no public number to check its replies
against, there is no adapter.

## Links

The tracking page opens an AWB from its `awbno` parameter. CourierManager serves every courier
on it from one host and tells them apart by `appcont`, so the library builds and reads only
addresses with Sinapseria's `appcont=17`.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
