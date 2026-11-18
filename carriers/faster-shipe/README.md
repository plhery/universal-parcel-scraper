# Faster Shipe

Faster Shipe (Fastershipe) is a domestic express courier in Riyadh with its own drivers, delivering
to Saudi cities. It is not Faster Express & Cargo, [faster-ae](../faster-ae/README.md) in the
catalog. Its site is fastershipe.com.

## Numbers

Its numbers are FS and nine digits, as its tracking page's script describes. Only one public example
is known, so there is no rule.

## Retrieval

The tracking page requests `/api/track.php?id=<number>`. The API identifies the shipment and marks its current milestone. Earlier and future milestones have no scan clocks, so the adapter returns a status summary. A missing shipment has a specific Arabic error on HTTP 404.

## Testing

`FASTER_SHIPE_TRACKING_NUMBER=… FASTER_SHIPE_UNKNOWN_NUMBER=… npm run test:carriers:live -- carriers/faster-shipe`
