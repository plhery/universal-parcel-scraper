# Orian

Orian parcels use enabled universal providers. There is no dedicated adapter.

Orian is an Israeli logistics group. Its Orian Express (OEX) arm flies e-commerce parcels to
Israel, clears them through customs and delivers them with Orian's own couriers, lockers and
pickup points. Another arm delivers parcels within Israel. Orian's international freight
forwarding has a separate tracker and is not covered.

## Numbers

The express and e-commerce tracker shows house numbers of nine digits, a hyphen and one digit,
as on an archived iHerb parcel from New York. The domestic tracker takes a twelve-digit
delivery order number or the parcel's barcode, and an archived lookup shows such an order
number. One public sample of each is known and both are digit runs that other carriers share,
so no rule claims them.

## Retrieval

The express page reads `/api/CargoTrackingSearch/GetShipments` with the tenant resolved by
the site's branding bootstrap and the search key. It follows the selected result's
`SecurityKey` to `GetShipment` for details. Results list house and customer references
together, so the complete requested reference must match before following a result.

The search can return an image CAPTCHA with its result. This is separate from the domestic
form's reCAPTCHA.

The [Shlager Android app](https://play.google.com/store/apps/details?id=shlager.il.swipbox.consigneeapp)
handles locker parcels after registration. The [official locker site](https://www.shlager.com/)
requires signing in with the phone used for the purchase; this is separate from express guest
tracking.

## Links

`tracking-ecom.orian.com/CargoTracking/public-tracking/search?searchKey={number}` opens one
express or e-commerce parcel; the tracking form on orian.com builds that address. The domestic
tracker reads `barcode` or `b` on `orian.com/OrianBarcodeTracking/`, and its form also sends a
reCAPTCHA answer.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
