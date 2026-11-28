# VEMO Logistik

VEMO Logistik shipments use enabled universal providers. There is no dedicated adapter.

VEMO Logistik delivers parcels and courier jobs the same day in Cologne and Bonn by cargo bike and electric van.

## Numbers

The form takes up to 13 digits. No public page shows one of its numbers, so there is no rule.

## Why there is no adapter

Each lookup needs the number and the delivery postcode. With no public number to check the tracker's replies against, there is no adapter.

## Links

The homepage's form opens `vemo-logistik.de/sendungsverfolgung?nummer=<number>&plz=<postcode>`; the link rule reads
the number. The catalog's link template takes only the number, so there is none.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
