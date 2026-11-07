# One by Allegro CZ

The Czech WeDo, IN TIME and Uloženka network, separate from
[Allegro One in Poland](../allegro-one/README.md).

## Retrieval

The official tracker reads GET https://edge.onedelivery.cz/one/tracking with the
whole label in packageNo and Allegro's media type. It needs no account, postcode,
cookie or CAPTCHA. English wording requires Accept-Language: en-US; bare en
returns Czech. The adapter shares the guest transport and English scan projection
with Allegro One while keeping the Czech endpoint and label scope separate.

The reply contains scans without repeating the label. Retrieval therefore binds the
whole query to the official Czech route and rejects a changed response URL or redirect.
Only standard logistics wording is projected; unknown prose becomes a generic update. The
scan is still there, so the history is not marked cut short.

Scan clocks keep their stated offsets and precision. Duplicate scans are removed and
history is sorted by its instants. A parcel waiting at a pickup point is ready for
collection until delivered. A courier taking an uncollected parcel back is interpreted
with its later journey, as in the shared Allegro scan projection.

## Limitations

Only the existing lettered Czech label scope is supported. Polish Allegro labels,
all-digit labels and package barcode suffixes are not admitted. An empty scan list
stays inconclusive because the service does not say whether it dropped an older
history. There is no estimate, location or partner identity in this reply.

One network failure gets a recorded retry inside the caller's deadline. Refusals,
rate limits, redirects and malformed replies remain distinct from an empty history.
Enabled universal providers remain available for recovery and completion.

## Testing

Set WEDO_TRACKING_NUMBER and optionally WEDO_UNKNOWN_NUMBER outside the repository,
then run npm run test:carriers:live -- carriers/wedo.
