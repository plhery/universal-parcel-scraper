# Teleport

Teleport parcels use enabled universal providers. There is no dedicated adapter.

Teleport is the logistics arm of AirAsia, run by Teleport Platforms Sdn Bhd in Malaysia. It flies
air cargo and e-commerce parcels across Southeast Asia and runs Teleport Next Day, a domestic
delivery service in Malaysia. Its site is teleport.it, and its tracker is on teleport.asia.

## Numbers

Its tracker shows numbers as TNTZ, 14 digits and MY. Teleport Next Day's own page gives TNX, eight
digits and MY. No public page shows a real number of either shape, so there is no rule.

## Why there is no adapter

Its tracking page is a JavaScript app that posts the numbers as JSON to
`global-api.teleport.asia/one-teleport-web-composite/api/v1/parcels/tracking`. The API checks
that the Origin header names www.teleport.asia. No public number is known to see a found reply.

## Links

`www.teleport.asia/track?tracking_number=<number>` opens one parcel. Teleport Next Day's tracking
page embeds the same tracker.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
