# We World Express

We World Express parcels use enabled universal providers. There is no dedicated adapter.

We World Express is a Hong Kong joint venture of Turkish Airlines' cargo arm, ZTO and PAL Air,
carrying e-commerce parcels from China and Hong Kong to Turkey and handing them to Turkish carriers
for delivery. Its site is weworldexpress.com.

## Numbers

Its tracker's placeholder and customer complaints show WWE, two letters, ten digits and YQ. The
complaints come from one complaint site, so the rule is low. SkyNet Worldwide is also called SkyNet
WWE, so the bare initials are not an alias.

## Why there is no adapter

The tracking page asks an open JSON endpoint, `POST /wwe/queryTrack2`, without a session or
CAPTCHA, and it answers public numbers with their events. An adapter can follow.

## Links

The tracking page takes the number in its form, so no address opens one parcel.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
