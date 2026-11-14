# X Express Serbia

X Express Serbia parcels use enabled universal providers. There is no dedicated adapter.

X Express Serbia, X Express DOO of Belgrade, is a Serbian courier with regional centres and
parcel lockers across Serbia. Its site follows that of [X Express](../x-express-ba/README.md) in
Bosnia and Herzegovina, but its tracker runs on its own host and takes another number layout, so
the two are kept apart.

## Numbers

Its tracking page takes a shipment number, which its example shows as two digits, a hyphen and
ten digits, or the shipment's GUID. No public page shows a real number, so there is no rule.

## Why there is no adapter

The tracking page posts the number with a reCAPTCHA v3 token it fetches as it loads and a small
sum check. With no public number to check its replies against, there is no adapter.

## Links

Its tracker takes numbers only through a form that posts them, so no address opens one shipment.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
