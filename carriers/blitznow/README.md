# Blitz

Blitz parcels use enabled universal providers. There is no dedicated adapter.

Blitz, formerly GrowSimplee, is an Indian delivery service for direct-to-consumer and omnichannel
sellers. It delivers same day, next day and quick-commerce orders in more than ten Indian cities.
Its site is blitznow.in. Its id carries the domain because other delivery firms use the Blitz
name.

## Numbers

Its tracking page asks for an AWB number. No public page shows one, so its format is unknown and
there is no rule.

## Why there is no adapter

Its tracking page is a JavaScript app that posts the AWB to `track-api.blitznow.in/api/track/` and
shows the JSON reply. No public number is known to see a found reply.

## Links

`track.blitznow.in/<number>` and `track.blitznow.in/track/<number>` open one parcel. The rule for
the first takes only a segment of letters and digits that holds a digit, so the app's other pages
do not match.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
