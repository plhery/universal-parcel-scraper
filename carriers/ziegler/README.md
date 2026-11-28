# Ziegler

Ziegler parcels use enabled universal providers. There is no dedicated adapter.

Ziegler Group, founded in Brussels in 1908, forwards goods by road, air, sea and rail from its
branches in Belgium, France, Switzerland and other countries. Its road shipments are tracked on
Easytrack, which takes a tracking number without an account.

## Numbers

Easytrack's script accepts eleven digits followed by eight more characters, nineteen in all, and
pads shorter input with zeros. No public page shows a whole number, so there is no rule.

## Why there is no adapter

The script opens `sending-details.php?ku=<number>&cd=<key>`, where the key is a SHA-256 hash of
the day's date. No public number is known to check its replies against.

## Links

The details page needs that day's key, so no fixed address opens a shipment, and the catalog
sends people to Easytrack.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
