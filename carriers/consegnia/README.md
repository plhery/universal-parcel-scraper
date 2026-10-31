# Consegnia Logistics

Consegnia Logistics parcels use enabled universal providers. There is no dedicated adapter.

Consegnia Logistics (Consegnia Logistics Corp.) is a Parañaque last-mile courier delivering brands' and online
shops' orders across the Philippines, with same-day and next-day delivery and cash on delivery; Samsung's
Philippine online store is among its clients. Its site is clc-express.com.

## Numbers

Its tracking numbers are `CLC` and nine digits, which `consegnia-1` claims at high confidence: buyers post them
in Samsung Members threads, archived lookups on its former tracker show them, and its tracker finds the recent
ones. Its tracker also takes the shop's order number, which belongs to the shop, so no rule takes it.

## Why there is no adapter

Its tracking page posts the number to an open JSON endpoint without a login or CAPTCHA:
`POST clc-express.com/track-delivery-result`, with the page's CSRF token in `_token` and the number in
`awb_number`, sent with the session cookies the page sets and `X-Requested-With: XMLHttpRequest`. A found number
gets HTTP 200 with an HTML fragment of its status and scans, on local clocks without an offset; an unknown one
gets HTTP 404 with `success: false`. HTTP 429 means too many lookups and 419 an expired session, neither a
missing parcel. Shipments moved over from its former tracker carry the move's date on every scan, while their
delivery date stays right. No adapter has been written for it yet.

## Links

The tracking page opens numbers from its `awb` parameter and searches them at once. Its former tracker on
consegnialogistics.com no longer resolves, so no rule reads its links.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
