# SAMUS

SAMUS parcels use enabled universal providers. There is no dedicated adapter.

SAMUS, UAB "SAMUS" of Vilnius, is a Lithuanian courier for letters and parcels with its own
couriers and sorting. An item it does not deliver itself is handed to a post, which tracks it
under its own code.

## Numbers

SAMUS's API documentation shows a parcel number of `LT`, nine digits and `LT`, and a label barcode
of two letters, nine digits and `LT`. Both take the UPU S10 layout with Lithuania's code and a
valid check digit, so detection reads them as postal items, and there is no rule.

## Why there is no adapter

The tracking page reads the number from its address and asks a JSON service for the parcel's
steps. With no number known to be live, its replies cannot be checked, so there is no adapter.

## Links

`https://www.samus.lt/siuntu-sekimas/?id={trackingNumber}` opens the tracking page on the number.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
