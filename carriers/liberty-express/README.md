# Liberty Express

Liberty Express is a courier from Caracas that receives purchases at its warehouse in Doral,
Florida, and delivers them in Venezuela and other Latin American countries.

## Numbers

The warehouse gives each purchase a warehouse receipt, `WR01-` and nine digits; each package's
label adds four digits after it. No rule claims them: BM Cargo's receipts share the layout. The
adapter takes any two-digit warehouse.

## Retrieval

The iQPack tracker needs no account or captcha. The adapter opens its search page for the
anti-forgery token and cookie, then posts the number with the hyphen, as the form does; without
the hyphen the tracker finds nothing. The search redirects a number it finds to the tracking page
of its warehouse receipt, which the adapter reads. A number it does not find comes back on the
search page with a notice that the guide does not exist. The tracking page must name the
receipt asked; a package's label number resolves to its receipt.

The search also takes the store's tracking number of a purchase, which the adapter does not
send: that number belongs to another carrier.

## Limitations

The history has statuses and clocks alone, with no place. The page names no zone, and its rows
come from Doral and from the destination country, so each keeps its wall clock.

## Links

The tracking page reads the receipt from its `nGuia` parameter, and the library reads the number
from that address. The library builds no links: the page redirects a number it does not hold to
a blank message page, and needs the hyphen the stored number drops.

## Testing

```sh
LIBERTY_EXPRESS_TRACKING_NUMBER=<public sample> LIBERTY_EXPRESS_UNKNOWN_NUMBER=WR01-999999990 \
  npm run test:carriers:live -- carriers/liberty-express
```
