# Komon Express

Komon Express parcels use enabled universal providers. There is no dedicated adapter.

Komon Express (可蒙国际物流) is a Shenzhen forwarder running small-parcel lines from China to the
United States, the United Kingdom, Australia, Canada and Europe, handing parcels to local carriers.
Its site is komonexpress.com.

## Numbers

A buyer's question shows KOMON, ten digits and YQ, and Komon's tracker answers it. It is one
sample, so the rule is low.

## Why there is no adapter

Its tracker is a tenant of the rtb56 platform, whose open lookup answers the public number without
a session or CAPTCHA, as for YY Post. It answers plain HTTP only, so the catalog checks a provider's
page instead of the carrier's site. An adapter can follow on the shared rtb56 client.

## Links

The tracker is HTTP only, so the catalog opens no carrier page.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
