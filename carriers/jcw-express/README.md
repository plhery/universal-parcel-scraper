# JCW Express

JCW Express parcels use enabled universal providers. There is no dedicated adapter.

JCW Express is a Chinese freight forwarder shipping online sellers' B2B, B2C and Amazon FBA orders from China to
the United States, Australia, Canada and Europe, with warehouses in China and the United States. Its site is
jcwexpress.com.

## Numbers

Its tracking page sends only numbers that start `JCW0` or `JCW1`, five to fifty letters and digits long.
ParcelPanel's archived JCW Express page shows one, JCW and eleven digits. One sample does not document the
format, so there is no rule.

## Why there is no adapter

Its tracking page posts the numbers to an open JSON endpoint behind Cloudflare, without a session or CAPTCHA:
`POST jcwexpress.com/api/v1/public/tracking` with `{"tracks": "<numbers, comma-separated>"}`. An unknown
number gets HTTP 200 with an empty `data` list. Its replies carry TrackingMore's field names and statuses, from
a cache in front of an outside tracking service, so an adapter should first check what they add. The
ParcelPanel sample gets the same empty list as a number JCW does not hold, so no found reply has been seen, and
an empty list does not tell an expired number from an unknown one.

## Links

The tracking page looks up the numbers in its `codes` parameter, separated by commas; the library reads the
first.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
