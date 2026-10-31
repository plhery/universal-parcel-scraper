# FlashBird

FlashBird parcels use enabled universal providers. There is no dedicated adapter.

FlashBird is a same-day courier for online shops in Ontario and Québec, based in Concord,
Ontario, taking orders from Shopify and other platforms. Its site is flashbird.ca.

## Numbers

Archived lookups on FlashBird's tracker hold twelve-digit numbers. Many carriers print twelve
digits, FedEx's among them with the same leading digits, so there is no rule.

## Why there is no adapter

The tracking page asks an open JSON service without a session or CAPTCHA, which answered a
public number with its scans and gives an empty reply for an unknown one. Its reply also holds
delivery photos, which an adapter would leave out. An adapter can follow.

## Links

Each parcel has its own page, `/tracking/<number>`, on flashbird.ca.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
