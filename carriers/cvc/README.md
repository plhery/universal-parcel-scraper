# CVC

CVC parcels use enabled universal providers. There is no dedicated adapter.

CVC, Си Ви Си ЕООД of Sofia, is a Bulgarian courier for parcels up to 31.5 kg and pallets, delivered
to addresses and through its own and partner offices across the country.

## Numbers

Its tracking page takes waybill numbers of digits, up to 20 of them. No public page shows a whole
number or its length, so there is no rule.

## Why there is no adapter

Its tracking page, on the e-CVC client site, finds a shipment by its waybill number. With no public
number to check its replies against, there is no adapter.

## Links

The tracking page's form sends the number as `wb`, with the `checkit` button value, so the portal
link carries both. A pasted `my.e-cvc.bg/track` link with a `wb` number names CVC.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
