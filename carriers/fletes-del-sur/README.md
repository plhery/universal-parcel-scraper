# Paquetería y Fletes del Sur

Paquetería y Fletes del Sur (PFS) carries parcels and freight within Mexico. The [public tracker](https://www.fletesdelsur.com/rastreo) accepts the seven-digit guide printed on the shipment receipt.

The `direct` step posts the guide to the public form's tracking endpoint. It verifies the exact guide in the result, then reads the dated route history and scan locations. Scan times are local wall clocks at minute precision. Delivery media and signer details stay out of the response. The adapter stops when the portal asks for CAPTCHA verification.

## Testing

Run `npm exec vitest -- run carriers/fletes-del-sur/adapter.test.ts`. Set `FLETES_DEL_SUR_NUMBER` and run `npm run test:carriers:live -- carriers/fletes-del-sur` for the native check.
