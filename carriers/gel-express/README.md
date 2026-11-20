# GEL Express

GEL Express parcels use enabled universal providers. There is no dedicated adapter.

## Numbers

A GEL Sendungsnummer has ten digits, as GEL's barcoding guide states and its tracker shows. A
return gets a number of its own, which the tracker lists under the outbound parcel. Ten bare
digits are printed by many carriers, so no rule claims them.

## Links

The [tracking form](https://www.gel-express.de/de/sendungsverfolgung/) posts `snr` to
`/de/sendungsverfolgung`. Its header search opens
`gel-express.de/sendungsverfolgung/?snr={number}`. The separate safe-drop authorization
asks for the recipient's postcode. The former tracker,
run by GEL's IT provider, read the number from `sean` on `thalmaier.de/gelsend/suche.php`.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
