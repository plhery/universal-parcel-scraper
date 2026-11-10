# Mixpakk

Mixpakk parcels use enabled universal providers. There is no dedicated adapter.

Mixpakk Kft. (brand MXP) is a parcel courier in Budapest for web shops. It delivers across
Hungary and also runs pallet transport, export and fulfilment. Its site is mixpakk.hu.

## Numbers

No public page shows a Mixpakk parcel number or its layout, so there is no rule.

## Why there is no adapter

Its tracking page posts the parcel id (`packageID`) to `apps.mxp.hu/nyomkovetes/query.php` and
lists each status with its date. With no public number to check its replies against, there is
no adapter.

## Links

The tracking page opens numbers from its `package` or `q` parameter.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
