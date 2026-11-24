`order.json` is the reply of `GET https://rhemate.com/order-manager/booking/api/SelfScheduling/Order/OrderNumber/<number>/PostalCode/<postcode>`
for the public sample in [`numbers.json`](../numbers.json) with the delivery postcode its source gives. The recipient's
name, street, phone and email are replaced by placeholders and the order's internal id by a synthetic one.
`tracking-status.json` is the reply of `GET …/SelfScheduling/order-tracking-status/<internal id>` for that order, and
`not-found.json` the lookup's reply for the invented order number 999999999 with the postcode 10115. The tests derive
their other replies from these.
