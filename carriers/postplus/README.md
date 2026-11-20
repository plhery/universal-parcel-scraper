# PostPlus

PostPlus parcels use enabled universal providers. There is no dedicated adapter.

## Numbers

PostPlus (Post+ B.V.) is a postal consolidator with its hub near Amsterdam Schiphol. It sorts
cross-border small packets and parcels and hands them to postal operators and other delivery
companies. Its tracking form's example is a UPU S10 number issued by Lithuania Post. Postal
detection names the issuing post for S10 numbers, so no rule claims them.

## Links

The home page reads a number from its `tracking` parameter and submits its tracking form with
it, so `post.plus/?tracking={number}` opens one parcel.

## Why there is no adapter

The tracking page asks `post.plus/api/tracking/search?code={number}` over plain HTTP, without a
verification; the service refuses a request that does not come from its own pages, which a
same-origin `Referer` or `Sec-Fetch-Site` header satisfies. It answers a list of parcels, each
with its numbers, destination country, delivery carrier and events, and `[]` for a number it does
not know. No public page shows a number PostPlus tracks, so the shape of a known parcel's events
is unverified.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
