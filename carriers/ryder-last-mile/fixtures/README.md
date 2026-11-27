Replies of Ryder Last Mile's DispatchTrack lookups for the first public sample in
[`numbers.json`](../numbers.json). `snapshot-1000672514.json` answers
`GET /api/v1/order_tracker/6b8db72`, with the recipient's name, address and phone, the drop's map
position, the driver and the live channel left out. `widget-1000672514.json` answers
`GET /track_orders/6b8db72/{number}`, cut to the order's numbers, status, delivery window and
events: the page template, the recipient, the driver, the truck, the items and the shipper's
details are left out. `not-found.json` and `widget-not-found.json` are the two lookups' answers for
an invented number, the widget's without its page template.
