# Westweg

Westweg parcels use enabled universal providers. There is no dedicated adapter.

Westweg GmbH is a German logistics company. It tracks parcels through its portal on the ITDIDA
platform, westweg.itdida.com.

## Numbers

No public page shows a Westweg number, so there is no rule.

## Why there is no adapter

The portal's platform answers `GET westweg.itdida.com/itdida-api/queryTracks?no=` with JSON, without
a session or CAPTCHA. An unknown number gets the error `单号不存在`. No public number is known to see
a found reply.

## Links

The portal's tracking page takes the number in its form, so no address opens one parcel.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
