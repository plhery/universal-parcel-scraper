# Post-International

Post-International parcels use enabled universal providers. There is no dedicated adapter.

Post-International, ТОВ «ПОСТ-ІНТЕРНЕЙШНЛ» of Kyiv, is a Ukrainian international express carrier
for parcels and mail: imports, exports and shopping abroad. Its partners include Ukrposhta and
Nova Poshta.

## Numbers

Its tracking form takes a parcel number. No public page shows a whole number or its layout, so
there is no rule.

## Why there is no adapter

The home page's form asks the site for the parcel and shows its status. With no public number to
check its replies against, there is no adapter.

## Leads

The form posts `trackingID`, the action `post_int_home_tracking_action` and a nonce from the page
to the site's WordPress handler, `/wp-admin/admin-ajax.php`. The reply holds the order's status as
HTML and the waybill (ТТН) of the carrier that takes the parcel on, a hand-off an adapter could
follow.

## Links

Its tracker takes numbers only through a form, so no address opens one shipment.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
