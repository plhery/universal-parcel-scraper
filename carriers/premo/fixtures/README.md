# Fixtures

Replies of `GET www.premo.se/paketsparning?id=<number>`, Premo's tracking page. Each is trimmed to the page's
title, its body tag and its tracking part: the search form, which repeats the number, and the events or the
error block. The header, menus, hero image, help blocks and footer are left out. The pages name no person or
address.

- `delivered.html`: the page for the first public sample in [`numbers.json`](../numbers.json), a parcel
  delivered by Premo's newspaper carrier.
- `partner.html`: the page for the second public sample, two failed rounds and then a partner carrier.
- `no-events.html`: the page for a public sample from Early Bird's
  [`numbers.json`](../../early-bird/numbers.json), which shows neither events nor the not-found answer.
- `not-found.html`: the page, with HTTP 200, for an invented number.
