# Citytrans

Citytrans parcels use enabled universal providers. There is no dedicated adapter.

Citytrans, Citytrans GmbH of Schlieren, formerly Citytrans Kurier GmbH, is a Swiss courier,
logistics and storage company with locations in Zurich, Bern and Basel.

## Numbers

Its tracker finds a shipment by its reference number, delivery-note number or ERP order number.
No public page shows a whole number or its layout, so there is no rule.

## Why there is no adapter

The "Sendungsverfolgung" bar on its home page, which needs no sign-in, posts the number to the
site's WordPress handler. It shows the shipment's three numbers, its loading and delivery places
with their date windows, and its status. With no public number to check its replies against,
there is no adapter.

## Leads

`POST /wp-admin/admin-ajax.php` with `action=get_data` and the number as `data`. The reply's
`body` is JSON text with `RefNr`, `LiefNr`, `ERPAUFTNR`, `LoadAddress`, `DeliveryAddress`, the
`LoadDate` and `DeliveryDate` windows, and the status.

## Links

Its tracker takes numbers only through a form that posts them, so no address opens one shipment.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
