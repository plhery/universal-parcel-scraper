# Citilogistics

Citilogistics parcels use enabled universal providers. There is no dedicated adapter.

Citilogistics is a Mississauga firm that imports and clears customs for foreign online shops selling into
Canada; [Canada Post](../canada-post/README.md) delivers the last mile, under its own 16-digit number.

## Numbers

Its consignment codes are eleven digits, and older ones were `CAM` and nine digits. Its tracker also takes
the Canada Post number. The public codes are archived lookups on its own tracker, and eleven digits match
many other carriers' layouts, so there is no rule. The older `CAM` codes match Purolator's three-letter
layout.

## Why there is no adapter

Its tracker needs no login or CAPTCHA, but a lookup takes two steps: the search page sets a session cookie
and a one-time form value `n`, and `GET tracking.citilogistics.ca/?n={value}&trackid={number}` with both
returns the history as HTML, each row with its own time zone. Without `n` the number is ignored, so there is
no shareable per-shipment address.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
