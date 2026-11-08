# Borzo

Borzo parcels use enabled universal providers. There is no dedicated adapter.

Borzo, formerly WeFast, is an on-demand same-day courier service within cities in India and
Indonesia. Its platform matches senders with independent couriers, and it issues its own tracking
codes, which recipients get in an SMS link. Its site is borzodelivery.com.

## Numbers

Its tracking codes reach recipients inside SMS links and no public page shows one, so their format
is unknown and there is no rule.

## Why there is no adapter

Its tracking page is a JavaScript app that looks the code up through Borzo's `/track` API with a
`tracking_code` field. No public code is known to see a found reply.

## Links

`borzodelivery.com/in/track/<code>` and `borzodelivery.com/id/track/<code>` open one parcel.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
