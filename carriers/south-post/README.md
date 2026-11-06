# South Post

South Post parcels use enabled universal providers. There is no dedicated adapter.

South Post S.A. is an Argentine postal operator licensed by ENACOM. It distributes parcels and
mail nationwide from branches in Buenos Aires, Córdoba, Tucumán, Mendoza and other provinces. Its
site is southpost.com.ar.

## Numbers

Its tracking numbers are digits only, at most seven, as its form allows. Short digit runs are
other carriers' numbers too, so there is no rule.

## Why there is no adapter

Its site is a script app. `/t/<number>` runs the lookup on load, posting the number as `nro_guia`
in JSON to `tracker.southpost.com.ar/seguimiento`.

## Links

`www.southpost.com.ar/t/<number>` opens one shipment: the home page's form builds it.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
