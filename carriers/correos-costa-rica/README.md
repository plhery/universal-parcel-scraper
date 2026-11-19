# Correos de Costa Rica

The adapter reads the public [Sucursal Virtual tracker](https://sucursal.correos.go.cr/web/rastreo)
through TRAWL. The official form creates its guest session, completes reCAPTCHA and submits
its own CSRF token. No account, phone digits or recipient input is used.

The browser capture binds the whole submitted reference to the POST and its redirect back
to the result document. Only the matching shipment number and movement rows leave the
context. Signer details, form fields, cookies and verification values are discarded.

Native minute clocks remain local wall clocks. The tracker supplies no offset. Its explicit
unregistered-shipment notice is distinct from verification failures and incomplete results.
Enabled universal providers remain available when the browser cannot finish verification.
The adapter is used for filed parcels; it adds no issuer rule or recognition probe.

## Testing

```sh
CORREOS_COSTA_RICA_TRACKING_NUMBER=... CORREOS_COSTA_RICA_UNKNOWN_NUMBER=... \
FLARESOLVERR_URL=... npm run test:carriers:live -- carriers/correos-costa-rica/adapter.live.test.ts
```
