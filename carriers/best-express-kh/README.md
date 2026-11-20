# BEST Express Cambodia

BEST Express Cambodia parcels use enabled universal providers. There is no dedicated adapter.

BEST Express Cambodia is the Cambodian parcel network of BEST Inc. Its tracker at kh.best-inc.com
runs on the same platform as [BEST Express Malaysia](../best-express-my/README.md)'s.

## Numbers

No public page shows a BEST Express Cambodia waybill, so there is no rule.

## Why there is no adapter

The tracker asks for BEST's rotate picture before it answers, as the Vietnamese and Thai ones
do, and [BEST Express Vietnam](../best-express-vn/README.md)'s `BestTracker` answers it. With no
public waybill to prove a lookup, BEST Express Cambodia stays on universal providers.

## Links

`kh.best-inc.com/track?bills={number}` opens the tracker with the number filled in; the tracker
script also reads `waybill`.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
