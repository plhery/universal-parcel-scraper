# SkyNet Malaysia

SkyNet Malaysia parcels use enabled universal providers. There is no dedicated adapter.

Skynet Worldwide (M) Sdn. Bhd. is a Malaysian courier based in Subang Jaya, with stations across
West and East Malaysia and international service through DPEX. It issues its own air waybills
and runs its own tracker, so it is separate from [SkyNet Worldwide Express](../skynet-worldwide/README.md)
and [SkyNet South Africa](../skynet-sa/README.md). Its site is skynet.com.my.

## Numbers

Its air waybills are twelve digits. Many carriers' numbers share that shape, so there is no rule.

## Why there is no adapter

Its tracking page posts the air waybill with a session token after a slider puzzle. Its JSON
tracking API needs an access token SkyNet issues to account holders.

## Links

No address opens one parcel.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
