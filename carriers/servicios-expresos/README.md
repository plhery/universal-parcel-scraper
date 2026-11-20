# Servicios Expresos

Servicios Expresos USA carries parcels from its Miami network to Venezuela. Its
public My Casillero page offers a tracking form alongside the account portal.
The adapter follows the number-only guest form with fresh anonymous form state
and checks the guide in the carrier's JSON response.

The guest page publishes guide `USA90007485`. Submitting it returns eight
dated movements, including customs in the United States and Venezuela and
final delivery. The search response supplies local clocks with seconds. The
adapter keeps that precision and uses the dated movement levels for the current
status. It skips the placeholder steps in the page, recipient and customer
details, free-text notifications and courier data.

The public USA site offers a phone-size tracking form and returned delivery
for that same guide. The tracking link opens this form, which submits the
number from the page. The adapter checks the returned guide before it accepts
movements.
A public reference producing a native absence has yet to be verified.

- [Servicios Expresos USA public tracking form and guide](https://casillerousa.serviciosexpresos.com/index.php)
- [Servicios Expresos USA phone-size guest tracker](https://usa.serviciosexpresos.com/)
- [Servicios Expresos Venezuela operations and tracking FAQ](https://venezuela.serviciosexpresos.com/faqs)

Run the guest check with `SERVICIOS_EXPRESOS_TRACKING_NUMBER=USA90007485 npx
vitest run --config vitest.carriers-live.config.ts carriers/servicios-expresos/adapter.live.test.ts`.
