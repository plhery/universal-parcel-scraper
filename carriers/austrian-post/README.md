# Austrian Post

Tracks domestic 22-digit and Austrian S10 postal numbers through the public
tracking website's anonymous GraphQL read.

## How it works

`direct` queries the public endpoint once and requires the returned item number
to match. The optional Post account flow is unnecessary for public history.

## Notes

Summary codes and scan codes use different vocabularies. A scan marked `IZ` can
describe completed delivery; its reason and wording determine the event stage.
Timestamps carry explicit offsets, which are preserved.

The query also asks for the measured size, in whole centimetres. It never
asks for the shipper, which the public page shows only after sign-in, or
anything about the recipient.

## Limitations

Account-only delivery options and recipient details are not retrieved. The
endpoint's delivery estimate is not read. Empty history and GraphQL errors
remain inconclusive so another source can help.

## Testing

Set `AUSTRIAN_POST_TRACKING_NUMBER` outside the repository, then run
`npm run test:carriers:live -- carriers/austrian-post`.
