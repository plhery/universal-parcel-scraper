# TCC

TCC parcels use enabled universal providers. There is no dedicated adapter.

TCC, formerly Transportadora Comercial Colombia, is a Medellín courier and freight company delivering parcels
across Colombia. TCCS, the Indian courier, is a separate entry. Its site is tcc.com.co.

## Numbers

Its remesa (guía) numbers are nine digits, as complaints the transport regulator quotes show, with no check
digit. Nine digits are shared by other carriers, so there is no rule.

## Why there is no adapter

Its tracker posts the number to a JSON endpoint that needs a reCAPTCHA v3 token with every lookup.

## Links

The tracking page fills its field in from its `documento` parameter; the visitor still presses search. The
library reads the number from these links only when their `tipo` is missing or names a remesa: the other types
carry the sender's order, invoice or reference numbers.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
