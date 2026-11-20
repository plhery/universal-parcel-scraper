# Alhosary International Shipping

Alhosary is a freight forwarder in Cairo with air, sea and road services across the
Middle East. Its [public Arabic tracker](https://alhosaryshipping.com/tracking) accepts
an AHS shipment number.

The adapter restores the printed hyphens and submits the same guest lookup as the
carrier's form. It reads the data fields in the Seroval response and checks the returned
shipment number. History uses the offset supplied by each event. Estimates, customer
details and cargo particulars stay outside the result.

The carrier publishes two demo references on its tracker. Both returned dated history
from the live lookup. The response fixtures retain status, scan times and locations.

Run the live test with `ALHOSARY_SHIPPING_NUMBER` set and
`npm run test:carriers:live -- carriers/alhosary-shipping`.
