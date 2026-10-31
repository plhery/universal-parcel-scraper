# Aquiline

Aquiline parcels use enabled universal providers. There is no dedicated adapter.

Aquiline, now AQ Tracking on aq-track.com, gives marketplace sellers its own number for parcels
that Amazon delivers in the United States and shows Amazon's scans under it. Buyers get these
numbers instead of Amazon's.

## Numbers

Its tracker accepts AQUAA, ten digits and YQ. A customer review and archived lookups on its own
tracker show such numbers. They come from two sources, so the rule is low.

## Why there is no adapter

The tracking page asks an open JSON endpoint without a session or CAPTCHA, and it answers public
numbers with their events. An unknown number gets an Unknown status rather than an error. An adapter
can follow.

## Links

The tracker opens a number from its path or from its `track` parameter, on both its current and
its former domain.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
