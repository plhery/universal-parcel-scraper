# First Logistics

First Logistics parcels use enabled universal providers. There is no dedicated adapter.

First Logistics (PT. Synergy First Logistics) is an Indonesian domestic courier based in Tangerang,
founded in 2007. It runs its own trace page at firstlogistics.co.id.

## Numbers

No public page shows a First Logistics waybill, which its trace page calls a HAWB number, so
there is no rule.

## Why there is no adapter

The trace page sends the number to a JSON endpoint on the same site without a login. With no
public number to check its replies against, there is no adapter.

## Links

The trace page reads no number from its address, so no address opens one shipment and the
library reads no link.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
