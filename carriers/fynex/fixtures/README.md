# Fixtures

Replies of `POST fynexcourierdubai.com/tracking/` with `trackno=<number>`, FyNEX's tracking page. Each is
trimmed to the page's title, its body tag and its tracking section: the search form and the tracking panel. The
header, menus and footer are left out. The page names no sender or recipient.

- `delivered.html`: the page for the public sample in [`numbers.json`](../numbers.json), a shipment from Ajman
  delivered in Al Ain.
- `empty.html`: the page, with HTTP 200, for an invented number: the tracking panel is empty, as it is when the
  page gets no number.
