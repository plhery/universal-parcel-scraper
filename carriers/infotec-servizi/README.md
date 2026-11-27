# Infotec Servizi

Infotec Servizi items use enabled universal providers. There is no dedicated adapter.

Infotec Servizi, in the province of Cosenza, delivers mail and judicial notices, mostly for public bodies. It is on
the Italian Ministry of Enterprises' register of postal operators.

## Numbers

The tracking form takes letters, digits and separators, at least seven characters once separators
are removed. No public page shows a real number, so there is no rule.

## Why there is no adapter

The tracking page asks `GET /tracking_proxy.php?ID=<number>` on the same site for JSON: the
product code, the recipient, the movements with their date, time, description and coordinates, and
a link to the delivery certificate. A reply of `0` sends the visitor to Poste Italiane's search
instead. With no public number to check its replies against, there is no adapter.

## Links

The tracker takes the number only from its form, so no address opens one item.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
