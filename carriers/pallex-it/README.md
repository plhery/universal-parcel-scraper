# Pallex Italia

Pallex Italia shipments use enabled universal providers. There is no dedicated adapter.

Pallex Italia, Italian Pallet Network from Fiorenzuola d'Arda, is the Pall-Ex group's express pallet network in Italy,
with its own depots and tracker. It is not Pall-Ex UK.

## Numbers

The tracker's own check takes IT and ten digits. No public page shows one, so there is no rule.

## Why there is no adapter

The tracker asks `GET https://tracking.pallexitalia.it/api/tracking/<number>?format=json`. With no public number to check the tracker's replies against, there is no adapter.

## Links

`tracking.pallexitalia.it/#track-and-trace/<number>` opens one consignment. The number sits in the address's
fragment, so no link rule reads it.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
