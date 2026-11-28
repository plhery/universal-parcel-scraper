# mail alliance

mail alliance shipments use enabled universal providers. There is no dedicated adapter.

mail alliance, run by mailworXs in Würzburg, joins regional private postal operators into a national network for
letters and for small goods (Warensendung PLUS and Paket PLUS).

## Numbers

No public page shows one of its numbers, so there is no rule.

## Why there is no adapter

The tracker is hosted by mail alliance's software supplier and asks `GET /api/GetStatusByNumberZip/<number>/<postcode>`.
With no public number to check the tracker's replies against, there is no adapter.

## Links

`sendungsverfolgung.tomatotools.de/<number>/<postcode>` opens one item; the link rule reads the number. The catalog's
link template takes only the number, so there is none.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
