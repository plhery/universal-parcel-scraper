# Memphis Courier

Tracks Memphis Courier shipments by their code.

Memphis Courier is a Brazilian import courier that clears shipments through Brazilian customs as
express imports. Its site is memphiscourier.com.br.

## How it works

`direct` reads the shipment from the service behind the client tracking page on
`clients.memphiscourier.com.br`,
`testapi.bitechsolucoes.com.br/api/tracking/found-house?account=&trackingNumber=<code>`: no
session, token or browser. The page's software supplier hosts that service under this name, and
the page sends no customer account.

The reply lists the shipments the code finds, each under its own code, and must list the
requested one. Each scan has a code, a Portuguese wording, a comment and a place column. The code
sets the stage: the page moves its step bar on FLT (created), BRP (customs), CLA (released) and
DLV (delivered). The inspections by customs (HOC) and by ANVISA, the health regulator (ANV), are
customs too. A code the map does not know gives no stage, and the parcel keeps its newest
known one, except a delivery, which a newer unknown code may have undone.

Scans carry a wall clock without an offset, so they are local clocks; a clock that ends with an
offset is read as an instant. A clock's fraction of a second is kept to the millisecond, so scans
apart by less than a second stay apart, and the app's identity policy lets such a scan take over
the row stored on its whole second.

## Numbers

A shipment the app tracked has M, seven digits and MIA, and the tracker lists it under that whole
code. No public page shows a code, so the rule is low and recognition asks the tracker.

## Limitations

The destination postcode, town and state, the comments, the customs flags and documents and the
package count are never read, though the page shows them. The reply's weight is read.

A missing shipment is an empty list. An HTTP 404 is read as a moved service, never as a missing
shipment, and a reply that says the lookup failed is a transport failure.

## Links

The tracking page opens with an empty form: no address opens one shipment.

## Testing

`npm run test:carriers:live -- carriers/memphis-courier`
