# FM Transportes

FM Transportes parcels use enabled universal providers. There is no dedicated adapter.

FM Transportes is a São Paulo carrier delivering online shops' parcels across Brazil. Its site is
fmtransportes.com.br.

## Numbers

Its tracking codes are eighteen characters: the day the order was created as day, month and year, then twelve
letters and digits. `fm-transportes-1` claims that layout at high confidence: customers post the codes in
complaints, and an archived reply of its own tracker shows one. The rule needs a letter after the date, as
eighteen digits are other carriers' numbers, and leaves out Zeleris's layout of two hexadecimal characters,
nine digits and a letter after the date.

## Why there is no adapter

Its tracker opens a session with a Cloudflare Turnstile token before any lookup; without one, its API refuses
the request.

## Links

The tracker reads the code from the fragment of `/#/<code>`.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
