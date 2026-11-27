# Mail Express

Mail Express items use enabled universal providers. There is no dedicated adapter.

Mail Express Poste Private, part of Mail Express Group of Rome, is a franchise network of private
post agencies for registered mail, ordinary mail and "posta certa", sold online through
UfficioPostale.it. Its delivery is run by Post & Service, the [Spike](../spike-express/README.md)
network. The group's licensee is on the Italian Ministry of Enterprises' register of postal
operators.

## Numbers

The tracking form asks for a 14-character ID. No public page shows a real one, so there is no rule.

## Why there is no adapter

The customer area's tracking page (`areaclienti-mailexpress.it/servizi_generici.aspx?a=tracingm`)
is an ASP.NET form that posts the ID with its view state. The page says it tracks the items of both
Mail Express and Post & Service. With no public number to check its replies against, there is no
adapter.

## Links

The tracker takes the ID only from its form, so no address opens one item.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
