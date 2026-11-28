# Bejot

Bejot shipments use enabled universal providers. There is no dedicated adapter.

Bejot carries furniture from Polish makers to homes in Germany, Czechia, Austria and the Benelux, carrying it in and
assembling it.

## Numbers

No public page shows one of its numbers, so there is no rule.

## Why there is no adapter

The homepage's form sends a short number to `/order/tracking/<number>` and a waybill with its security key to
another address. With no public number to check the tracker's replies against, there is no adapter.

## Links

The link rule reads the number from `bejotlogistics.com/order/tracking/<number>`. No public page shows that this
address opens a shipment without the security key, so there is no link template.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
