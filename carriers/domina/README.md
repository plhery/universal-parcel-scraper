# Domina

Domina parcels use enabled universal providers. There is no dedicated adapter.

Domina Entrega Total is a Colombian courier and logistics company.

## Numbers

Its tracker takes a guide number (número de guía). No public page shows a Domina number, so there is
no rule.

## Why there is no adapter

The tracker sits behind Cloudflare, which lets a request with a browser's headers through. Its
picture CAPTCHA is no barrier: `GET https://trackingbk.infokairos.com.co/api/v1/captcha` sets the
answer, base64-encoded, in its `captcha` cookie, and `POST /api/v1/tracking` with that cookie and
`{"captcha", "trackingId"}` answers the guide. A wrong answer reads "CAPTCHA incorrecto" and a
missing cookie "CAPTCHA expirado", both with HTTP 200; a guide the tracker does not know gets HTTP
404 and "Tracking doesn't exist!". The page reads a found guide's `externalGuide`, `sender`,
`recipient`, `origin`, `destination`, `status` and `tracking` rows of `date` and `status`. The
public guides seen so far are from 2014 and 2020 and are gone, so no found reply has been seen.

The proof of delivery needs a code sent to the recipient (`/api/v1/tracking/requestCode` and
`validateCode`), so an adapter would not read it.

## Links

The tracker's script would read a guide from `/idenvio/<number>`, but the server answers that
address with 404, so there are no tracking links.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
