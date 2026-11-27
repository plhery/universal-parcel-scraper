# La Nuova Posta

La Nuova Posta items use enabled universal providers. There is no dedicated adapter.

Gruppo La Nuova Posta of Rome runs a franchise network of private post offices for registered and
ordinary mail, judicial acts and parcels. The group and many of its franchisees, named "La Nuova Posta
di …", are on the Italian Ministry of Enterprises' register of postal operators.

## Numbers

The tracking form takes digits only, and its own example has thirteen. No public page shows a real
number, so there is no rule.

## Why there is no adapter

The tracking page opens `nuovaposta.com/tracking/<number>/`, which posts the number as `trackingcode`
to `posta.glnp.it/index.php/api/getTrackingInfo`. The JSON reply holds a status, a title, the
outcome's text and, for an item held for collection, the office that holds it. With no public number
to check its replies against, there is no adapter.

## Links

`nuovaposta.com/tracking/<number>/` opens one item.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
