# Linear Logistics

Linear Logistics parcels use enabled universal providers. There is no dedicated adapter.

Linear Logistics, formerly Parcelink Logistics, delivers long items such as blinds and curtain poles across
the UK. Its scans are DX's. Its site is linearlogistics.co.uk.

## Numbers

Its numbers are ten digits starting `70`, the layout of DX's secure-delivery references, and ten digits are
shared by many carriers, so there is no rule. Archived lookups on its own tracker show two.

## Why there is no adapter

Its tracker reads an open JSON lookup without a session or CAPTCHA and says when a number is not found.
No adapter has been written for it yet.

## Links

The tracking page opens numbers from its `q` parameter, as did the older tracking.linearlogistics.co.uk.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
