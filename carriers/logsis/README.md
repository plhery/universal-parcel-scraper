# Logsis

Logsis parcels use enabled universal providers. There is no dedicated adapter.

Logsis (Логсис), ООО «Логсис Групп», is a Russian courier for online shops, delivering in Moscow and
St Petersburg and, through partners, elsewhere in Russia.

## Numbers

Its tracker takes the shop's order number or a Logsis tracking number. No public page shows a whole
number or its layout, so there is no rule.

## Why there is no adapter

The tracker asks for the recipient's phone, the one given with the order, as well as the number.
With no public number to check its replies against, there is no adapter.

## Leads

The form posts `track_num` and `phone_num` to `https://logsis.ru/api/tracking`.

## Links

The tracker takes the number only with the phone, in a form that posts them, so no address opens
one shipment.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
