# Rhenus Germany

Rhenus Home Delivery is the Rhenus group's two-person and bulky-item home delivery company in Germany. Inntralog, its
two-man delivery company for furniture and large appliances, has its own tracker and entry. Tracked through the
booking service behind its recipient portal, rhenusmydelivery.com, with the delivery postcode.

## How it works

1. `direct`: one `GET https://rhemate.com/order-manager/booking/api/SelfScheduling/Order/OrderNumber/{number}/PostalCode/{postcode}`,
   the lookup the portal's form makes, then one
   `GET https://rhemate.com/order-manager/booking/api/SelfScheduling/order-tracking-status/{internalOrderId}` for the
   order's steps. The portal's `assets/environment.json` names the service. No cookie, key, CAPTCHA or browser is
   needed; the portal's Friendly Captcha guards only its contact form.
2. `retry`: one more read after a network failure or a timeout. The first gets half of the budget.

- Every lookup needs the postcode, but a parcel can be added without one. Without it the adapter makes no request and
  reports `input_required`, and enabled universal providers answer instead.
- An unknown order number and a wrong postcode both get `{"isOk":false,"order":null}`. That answer does not show the
  order is missing, so it is `indeterminate` (`portal_not_found`).
- The lookup's order must carry the number asked. A 403 is a challenge, a redirect a moved service, and any other
  reply a schema failure. Failures drop the request details `fetchBounded` attaches: the address holds the postcode.
- There is no recognition, since every lookup needs the postcode.

## Notes

- The order's current status sets the stage, worded as the portal words it. Its steps give the history: each step the
  service marks `Success` is a row with the instant and offset it states; steps still ahead are left out.
- The delivery window is the estimate until the order is delivered or stopped.
- The order's reply also holds the recipient's name, address, phone and email, which the adapter never reads.
- The portal's links from Rhenus's emails, `orderinformation?o={number}&m={hash}`, open an order without the postcode
  through `…/SelfScheduling/Order/OrderNumber/{number}/Hash/{hash}`. The adapter does not take them.

## Limitations

- No place, weight or depot.
- The steps are coarse: recorded, goods in the depot, on the way, delivered.

## Numbers

The portal takes the retailer's order number, digits for IKEA and letters and digits for other retailers. Nothing in
it points to Rhenus, so there is no rule. The samples and their sources are in [`numbers.json`](numbers.json).

## Links

The portal takes the number and postcode in a form, so no link names it.

## Testing

`npm run test:carriers:live -- carriers/rhenus-de` reads the public sample with the postcode its source gives, or
`RHENUS_DE_TRACKING_NUMBER` with `RHENUS_DE_POSTCODE`; with `RHENUS_DE_UNKNOWN_NUMBER` it checks that number is
inconclusive.
