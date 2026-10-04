# STO Express

Chinese domestic STO parcels use enabled universal providers. There is no dedicated adapter.

## How it works

The official website embeds the customer-service tracker from `site.sto.cn`. That embedded
route redirects to the main website instead of returning shipment history. No working,
identity-bound anonymous carrier feed is available to the package.

## Limitations

The catalog's numeric pattern overlaps other carriers; it is a routing candidate, not proof
of STO ownership. A website redirect must not be reported as parcel absence.

## Testing

Provider live-test inputs and commands are in the [provider READMEs](../../providers/README.md).
