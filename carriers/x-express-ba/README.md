# X Express

X Express parcels use enabled universal providers. There is no dedicated adapter.

X Express in Serbia has its own tracker and number layout:
[X Express Serbia](../x-express-rs/README.md).

## Numbers

X Express shipment numbers are X or A followed by nine digits, or eight digits, as the tracking
page and the guide to the shipment-booking app show. No rule claims them: the A layout falls in
Allegro One's range, and the other layouts are short shapes other carriers print.

## Links

None. The tracking page posts the number with a reCAPTCHA and a small sum check, so no address
opens one parcel.

## Why there is no adapter

The [public form](https://www.x-express.ba/korisnicki-panel/pracenje-posiljke)
posts the whole number with a reCAPTCHA v3 response it fetches as it loads and
the answer to its displayed addition. One ordinary form submission with a
carrier-published example reached the explicit missing-shipment notice. A
dated public positive and an automated retrieval control remain necessary.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
