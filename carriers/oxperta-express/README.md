# Oxperta Express

Oxperta Express parcels use enabled universal providers. There is no dedicated adapter.

Oxperta Express is a franchise parcel courier network based in Barberà del Vallès, near Barcelona,
with agencies across Spain. It sends parcels abroad through partners. Its site is
express.oxperta.com.

## Numbers

Its tracking numbers, called localizadores, are eight to thirty letters and digits by the tracking
widget's check, and the published examples are sixteen digits. Sixteen bare digits fit many
carriers' numbers, so there is no rule.

## Why there is no adapter

Its tracking page is a script widget that reads the `localizador` parameter and asks
`GET tracking-pro.oxperta.com/api/tracking/<number>`, which answers 404 for an unknown number. No
found reply has been seen.

## Links

`express.oxperta.com/seguimiento-de-envio/?localizador=<number>` opens one parcel.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
