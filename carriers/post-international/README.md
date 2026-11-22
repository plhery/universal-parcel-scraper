# Post-International

Tracks Post-International, ТОВ «ПОСТ-ІНТЕРНЕЙШНЛ» of Kyiv, a Ukrainian international express
carrier for parcels and mail, imports, exports and shopping abroad, through the tracking form on its
home page. Its partners include Ukrposhta and Nova Poshta.

## How it works

`direct` reads the nonce the home page gives its form, keeps it for an hour, and posts the number,
the action `post_int_home_tracking_action` and the nonce to the site's WordPress handler,
`/wp-admin/admin-ajax.php`, with no session or account. When WordPress refuses a kept nonce, the
adapter reads the page again once. A request that fails to reach the site gets one `retry` in the
rest of the budget.

The handler writes blank lines before its JSON, whose `orderStatus` is the HTML the form shows:
a heading with the number, the current status with the delivery service, the onward carrier's
waybill (ТТН) and the status history, oldest first, as a date and a time with no zone, kept as
Kyiv's wall clock. An empty `orderStatus` is a number the tracker does not know. The tracker also
answers with shipments it finds under other numbers, so a reply counts only when its heading
repeats the whole number asked; another shipment's reply is indeterminate.

The system writes rows it dates by their day alone at midnight with a count of seconds, 00:00:01
and on; the adapter keeps their day. A ТТН the reply names is the result's
`delivery_tracking_number`, with Nova Poshta or Ukrposhta as `delivery_carrier` when the delivery
service names one. The delivery address is never read.

## Limitations

The history names no places beyond the EU terminal and the Ukrainian sorting centre in its
wording. Its own numbers, such as two letters, thirteen digits and `UA`, have no documented layout,
so the carrier is never detected and needs explicit selection. A partner's reference the tracker
finds a shipment by, such as a Boxberry number, is indeterminate, since the heading names
Post-International's own number.

## Links

The form posts the number, so no address opens one shipment.

## Testing

`POST_INTERNATIONAL_TRACKING_NUMBER=… POST_INTERNATIONAL_UNKNOWN_NUMBER=… npm run test:carriers:live -- carriers/post-international`
