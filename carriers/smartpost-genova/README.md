# Smartpost Genova

Smartpost Genova items use enabled universal providers. There is no dedicated adapter.

Smartpost Genova S.r.l. is a private post in Genoa for printing, enveloping and tracked delivery of
mail. It is on the Italian Ministry of Enterprises' register of postal operators.

## Numbers

Each envelope carries its own barcode, whose layout no public page shows, so there is no rule.

## Why there is no adapter

Its site sends recipients to Post Office Manager, a tracker shared by several operators, each under
its own `domain` value. The page posts the barcode as `search` with `domain=smartpostgenova`.
With no public number to check its replies against, there is no adapter.

## Links

The tracker takes the barcode only from its form, so no address opens one item.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
