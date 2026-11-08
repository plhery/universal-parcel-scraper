# Fillo

Fillo parcels use enabled universal providers. There is no dedicated adapter.

Fillo Lojistik A.Ş., of Istanbul, distributes partial loads and parcels in all 81 provinces of
Türkiye and delivers bulky goods with two-person crews as Fillo XL. It belongs to Aras Holding but
runs its own network and tracker, apart from Aras Kargo. Its site is fillo.com.tr.

## Numbers

Its ATF numbers are seven letters or digits. Shippers can also look up their own dispatch-note
(irsaliye) numbers. Seven characters fit many other carriers' numbers, and no public page shows
one, so there is no rule.

## Why there is no adapter

Its tracker posts each lookup as JSON with a Cloudflare Turnstile token from the widget on the
page. No public number is known to see a found reply.

## Links

The links it sends carry an encrypted `q` value instead of the number, so no address opens one
parcel by number.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
