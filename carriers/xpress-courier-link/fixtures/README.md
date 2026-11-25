# Fixtures

Replies of `GET xpresscourierlink.com/tracking/?txtstatus=<service>&search=<number>`, ECL's tracking page.
Each is trimmed to the page's title, its body tag and its tracking part: the search form, which repeats the
service and the number, and the results. The header, menus and footer are left out.

- `international.html`: the international service's page for the public sample in
  [`numbers.json`](../numbers.json), a shipment from Sialkot to Dubai. The shipper's and consignee's names are
  replaced by placeholders.
- `not-found.html` and `not-found-domestic.html`: the pages, with HTTP 200, each service gives for an invented
  number.
