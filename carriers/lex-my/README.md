# LEX Malaysia

LEX Malaysia parcels use enabled universal providers. There is no dedicated adapter.

LEX (Lazada Express) is the Lazada marketplace's delivery network in Malaysia. Its site is lex.com.my. Lazada
runs LEX in other countries on their own sites; this entry covers Malaysia only.

## Numbers

Its numbers are `TMYLE` and nine digits, which `lex-my-1` suggests at low confidence; the only public
example is an archived lookup on its own tracker. Parcels it delivers for other networks keep their numbers.

## Why there is no adapter

Its tracking page reads an open JSON API without a session, but the API has been seen behind a slider
CAPTCHA, and the only public number now answers with an empty history.

## Links

The tracking page opens numbers from its `references` parameter.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
