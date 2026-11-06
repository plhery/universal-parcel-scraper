# PuntoPost

PuntoPost parcels use enabled universal providers. There is no dedicated adapter.

PuntoPost is the brand of PuntoPost Technologies México, S.A. de C.V. It runs a network of more
than three thousand pickup points across twelve Mexican states, centred on Mexico City. Online
shops deliver parcels to its points, and it sells shipping from one point to another. Its site is
puntopost.mx.

## Numbers

Its tracking numbers start with MX, followed by ten or eleven letters and digits. Only an
aggregator's example shows a whole number, so there is no rule.

## Why there is no adapter

Its tracking page is a script that reads the number from the address's fragment and asks
`back.puntopost.mx/api/web/v1/parcels/` for that parcel.

## Links

`www.puntopost.mx/tracking-summary/#<number>` opens one parcel: the home page's form builds it.
The page does not read a number placed in its path.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
