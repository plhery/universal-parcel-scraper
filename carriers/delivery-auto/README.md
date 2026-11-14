# Delivery

Delivery parcels use enabled universal providers. There is no dedicated adapter.

Delivery, ТОВ «Делівері» of Kyiv, is a Ukrainian road carrier of parcels and freight from 1 kg to
8 t, between its own warehouses and from and to addresses across the country. Its site,
delivery-auto.com, also calls it Delivery Auto.

## Numbers

Its site reads ten digits as a receipt (waybill) number, and also takes eleven characters with a
symbol at either end; four to eight digits are a pickup request instead. Ten digits fit many
carriers' numbers, and no public page shows a whole receipt number, so there is no rule.

## Why there is no adapter

The receipt page asks the site for the receipt's details and shows its status between branches.
With no public number to check its replies against, there is no adapter.

## Leads

The site's search posts the number as `id`, with `delGruop` set to 1, to
`/uk-UA/Receipts/DetailsNew`, which answers with the receipt's details as HTML.

## Links

`https://www.delivery-auto.com/uk-UA/Home/SearchReceipt?number={trackingNumber}` opens the receipt
page on the number. A pasted link to that page, in any of the site's languages, names Delivery.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
