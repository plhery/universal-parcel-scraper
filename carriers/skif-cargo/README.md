# Skif-Cargo

Skif-Cargo (Скиф-Карго), ООО «Компания Скиф-Карго», is a Russian road freight company for groupage,
deliveries to retail chains and express freight, with warehousing and 3PL services, through more
than 50 branches. Tracked through its tracking page's own lookup.

## How it works

1. `direct`: three requests, as the tracking page and its script make them.
   - `GET https://www.skif-cargo.ru/tracking/` sets `_ck_hostonly`.
   - `GET https://www.skif-cargo.ru/getProfile/` is the account check the script makes on load.
     It refuses an anonymous visitor with HTTP 200 and `{"status": 401}`, but only a request
     carrying `_ck_hostonly` gets Django's `csrftoken` cookie with that refusal.
   - `POST https://www.skif-cargo.ru/tracking/` sends the number as the whole body, with the
     cookies and the token in `X-CSRFToken`. The reply is the application and its route.
2. `retry`: one more attempt in a new session when the first fails to reach Skif-Cargo or hangs,
   inside the budget.

- The page's own request carries no captcha answer, and neither does the adapter's. The
  captcha the page loads guards its callback form.
- A lookup without the cookie is refused with HTTP 403 and Django's "Ошибка проверки CSRF",
  which is inconclusive. Any other 403, or a captcha or firewall page in place of a page or
  the reply, is a challenge. An unknown number is HTTP 200 with a null `order_tracking`.
- The reply must name the number as its short application number or its full one.
- No recognition: detection never offers Skif-Cargo, so preflight would not ask it.

## Notes

- The route is a list of points: the collection from the sender, Skif-Cargo's warehouses, and
  the delivery to the consignee. Each point is reached or still ahead (`point_status` 0), as
  the page draws it. Reached points are scans on their day; points ahead are planned steps.
  The page shows the last point's day as the expected delivery while that address is ahead.
- The shipment's state, such as «Груз выдан получателю.», is the current status. Once the
  state says the cargo is issued, the reply's issue time (`CompleteDate`) is the delivery
  scan, at the consignee's town.
- Points and states come as wording alone, staged in [statuses.json](statuses.json).
- Russia spans eleven zones and the reply names none, so the issue time stays a wall clock.
- Only the state, the points, the issue time and the measured weight are kept. The parties,
  the cargo's contents, volume and pieces, and the price are not.

## Numbers

An application number is five digits, ` - ` and four digits, and the tracker finds it by its
digits alone. The tracker also takes a customer's own order number, which the reply does not
name, so the adapter takes digits only. Nine digits are shared by many carriers, so no rule
claims them. The samples and their sources are in [`numbers.json`](numbers.json).

## Links

The catalog links the empty tracking page. `www.skif-cargo.ru/tracking/{number}` is the page's
address for one shipment, but its script reads the number before its router has it, so the page
opens without looking it up.

## Testing

`npm run test:carriers:live -- carriers/skif-cargo`, with `SKIF_CARGO_TRACKING_NUMBER` and
optionally `SKIF_CARGO_UNKNOWN_NUMBER` set outside the repository.
