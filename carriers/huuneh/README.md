# Huuneh

Huuneh parcels use enabled universal providers. There is no dedicated adapter.

Huuneh is a courier in Ontario, Canada. It delivers next-day and same-day parcels for pharmacies,
florists and online shops across the Greater Toronto Area, the Golden Horseshoe and the Waterloo
area. Its site is huuneh.com.

## Numbers

Its waybill numbers are AWB and ten digits. Only an aggregator's example and the tracking
form's placeholder show the layout, so there is no rule.

## Why there is no adapter

Its tracking page is rendered on the server: the form sends one or more numbers to `track.php`
as `order_track`, and the result comes back as HTML.

## Links

`huuneh.com/dashboard/track.php?order_track=<number>` opens one parcel: the tracking form builds it.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
