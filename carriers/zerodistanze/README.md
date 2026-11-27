# Zerodistanze

Zerodistanze items use enabled universal providers. There is no dedicated adapter.

Zerodistanze S.r.l. of Fasano runs a franchise network of private post points for registered and
ordinary mail and parcels. It and its franchisees are on the Italian Ministry of Enterprises'
register of postal operators.

## Numbers

Items carry a barcode whose layout no public page shows, so there is no rule.

## Why there is no adapter

The home page's "Rintraccia la tua spedizione" form opens `/Home/Track?Barcode=<number>`, a server
page. With no public number to check its replies against, there is no adapter.

## Links

`zerodistanze.it/Home/Track?Barcode=<number>` opens one item.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
