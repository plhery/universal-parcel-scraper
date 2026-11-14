# Baikal Service

Baikal Service parcels use enabled universal providers. There is no dedicated adapter.

Baikal Service (Байкал Сервис), ООО «Байкал-Сервис ТК», is a Russian road carrier for groupage and
part loads, door to door, with branches and terminals across the country.

## Numbers

Its tracker takes a forwarding receipt number, an application number or a cargo number. The page's
script checks their layouts: an application is seven digits, a receipt two Cyrillic letters, a
hyphen and seven digits, and a cargo number two Cyrillic letters, a hyphen, a Cyrillic letter and
six digits. Seven digits fit many carriers, and no public page shows a whole number, so there is no
rule.

## Why there is no adapter

The page's script asks Baikal Service's API for the number with a fixed key it gives every visitor.
With no public number to check its replies against, there is no adapter. Fuller detail is in the
customer account.

## Leads

The page calls `GET https://api.baikalsr.ru/v1/tracking` with the number as `number`, several
numbers separated by commas, under HTTP Basic authentication with the key from its script.

## Links

The tracker takes the number only in its script form, so no address opens one shipment.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
