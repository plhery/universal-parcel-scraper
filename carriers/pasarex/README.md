# PasarEX

PasarEX parcels use enabled universal providers. There is no dedicated adapter.

PasarEX (Pasar Express) is a Bogotá courier running international express, air cargo and last-mile
delivery in Colombia, Chile, Panama and Barbados. It delivers Amazon parcels in Colombia. Its site
is pasarex.com.

## Numbers

Amazon numbers of AMZPSR and nine digits were looked up on PasarEX's tracker, as archived copies
show. The copies keep only the search form and come from one source, so the rule is low.

## Why there is no adapter

The tracker answers only after a reCAPTCHA checkbox. Its form sends
`GET https://tracking.pasarex.com/tracking` with `awb` and the checkbox's `g-recaptcha-response`
token, and the page comes back with the history rendered on the server: a plain request with a
token the checkbox issued gets the same page, with no cookie. Without a token, or with a refused
one, the tracker says no parcel was found, so that answer proves nothing about the parcel.

An adapter would need a browser helper that ticks the checkbox, submits the form and reads the
result page bound to the whole `awb`. The checkbox passed without an image challenge from a
residential network; whether it does from a server is untested.

## Links

Tracking links carry the number as `awb` on tracking.pasarex.com.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
