# Sicilposte

Sicilposte items use enabled universal providers. There is no dedicated adapter.

Sicilposte of Palermo is a private post office for mail and judicial acts. It is on the Italian
Ministry of Enterprises' register of postal operators.

## Numbers

No public page shows a number or its layout, so there is no rule.

## Why there is no adapter

The search page is a plain form that reads `tracking` from its address
(`index.php?pagina=ricerca&tracking=<number>&submit_track=Cerca`) and answers with a server page.
With no public number to check its replies against, there is no adapter.

## Links

`sicilposte.it/index.php?pagina=ricerca&tracking=<number>` opens one item.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
