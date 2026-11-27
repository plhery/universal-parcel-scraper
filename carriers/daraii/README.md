# Daraii

Tracks orders of 香港全速易物流 (香港全速易物流有限公司), a Hong Kong cross-border e-commerce
forwarder that tracking directories list as Daraii, the name shown here. Its site and tracker are
on kynitha.com.

## How it works

`direct` posts the number to the service behind the public tracking page,
`www.kynitha.com/getOrder`, as the form field `orderNo`, the way the page's script does. No
session, token or browser.

The reply's shape and statuses are taken from the page's script, `js/track.js`. The reply is the
order's scans: each has a clock, a message, the order's number, its origin and destination, and a
status. Each scan is an event worded with its message. The script states the order's status from
its newest scan alone: status 2 is "Delivered", and any other is "In Transit". That status sets
the stage and becomes `provider_code`; the scans keep no stage of their own.

The page cuts each clock to its day and time of day and never shows how the service writes it.
A clock is read only with the offset written after it; a reply whose clocks carry none fails as
a changed service, and the lookup goes on to the enabled universal providers.

Every scan must carry the requested number. The destination after the page's arrow becomes the
destination country, by its name or code, or stays a name when it names no country.

## Numbers

No public page shows one of its numbers or their layout, so there is no rule: the carrier is asked
when it is selected. The adapter sends one token of 5 to 40 letters, digits, hyphens and
underscores.

## Limitations

The reply holds scans and nothing else, so an order without a scan gets the same empty list as a
number never issued, and the page answers both that the number has no tracking information. That
answer is inconclusive (`portal_not_found`), never a missing order.

The scans' messages have no codes and no stage, and the origin country is not read. The page has
no link that opens one number.

The found path rests on a synthetic fixture built from the script: the service's own clocks and
statuses may differ.

## Testing

`npm run test:carriers:live -- carriers/daraii`

The unknown-number case sends an all-zero placeholder, or `DARAII_UNKNOWN_NUMBER` when set.
`DARAII_TRACKING_NUMBER`, set outside the repository, adds the found case.
