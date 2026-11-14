# Rail Continent

Rail Continent parcels use enabled universal providers. There is no dedicated adapter.

Rail Continent (Рейл Континент), ООО «Реил Континент М», is a Russian road and rail groupage
carrier with more than 50 branches.

## Numbers

Its tracking page says a waybill number (ТТН) is a Cyrillic capital Т and seven digits. No public
page shows a whole number, so there is no rule.

## Why there is no adapter

The tracker asks for the waybill number and then for the PIN code printed beside it on the waybill.
With no public number to check its replies against, there is no adapter.

## Leads

The form sends the waybill number as `order` to `/ajax/track.php`, and a second form then asks for
the PIN as `pin`.

## Links

The tracker needs the PIN with the number, so no address opens one shipment and the catalog sends
people to the tracking page.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
