# Cargo24

Cargo24 shipments use enabled universal providers. There is no dedicated adapter.

Cargo24, from Schafisheim, is a Swiss network of partner hauliers for groupage and pallets, with an overnight hub
and city deliveries across Switzerland.

## Numbers

No public page shows one of its numbers, so there is no rule.

## Why there is no adapter

The lookup takes the consignment number and the delivery postcode. With no public number to check the tracker's replies against, there is no adapter.

## Links

The site's form opens `cargo24.app/portal/aor/tracking.aspx?id=<number>&plz=<postcode>`; the catalog's template
cannot carry the postcode, so only the link rule reads that address.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
