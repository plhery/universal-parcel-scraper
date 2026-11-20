# USEND Chile

USEND is a Chilean courier for business and e-commerce parcels, carried by road between its
agencies in Santiago and the regions and delivered to the door. Tracked through its guest tracker's
page for a guide.

## How it works

1. `direct`: one `GET https://portal.usend.cl/rastrear-shipper/{guide}`, the page `usend.cl` links
   a number to. It needs no cookie, token or browser. The search form on `usend.cl` carries a
   CAPTCHA, but the page it opens does not ask for one.
2. `retry`: one more request when the first fails to reach the service or hangs. The first gets
   half of the budget, so the retry fits in the rest.

- The page's heading must name the whole guide asked.
- A guide the tracker does not hold is HTTP 200 with an empty heading and a notice that the
  "guía/cod. de seguimiento" does not exist, read as not found for a `WB` guide. The page gives
  the same notice for a shipment's tracking code, which it does not look up by, so for any other
  shape that notice is inconclusive (`portal_not_found`).
- A 403 or a browser check is a challenge, a 429 a rate limit, and a redirect or a 404 a moved page.

## Notes

- The "Historial" card lists the guide's movements newest first under a day per group,
  "Tuesday, 18 de June del 2024", always with English names, and a clock such as "10:07 pm". With
  no zone given, each stays the agency's wall clock as `local_time`.
- USEND's wording stages a movement; any visit of "SALIO A ENTREGARSE (… Visita)" is out for
  delivery. A wording the map does not know falls to the shared rules.
- After a delivery the history follows the signed delivery receipt (the "cargo") back to the
  origin agency and the shipper. Those movements are the paperwork's, not the parcel's, and are
  left out.
- A movement's agency becomes its `location`; for a dispatch, the agency it left.
- The page also shows the shipper, the recipient's name and address, the pieces with their own
  timelines, weights and sizes, the courier and vehicle of each run, who signed with their ID
  number, delivery photos and GPS points. None of them is kept.

## Limitations

- No instants, estimate, service or delivery time beyond the movement's clock.
- Only guides: the tracker does not open a shipment by its tracking code or a piece's barcode
  through this page.

## Numbers

A USEND guide is `WB` and nine digits. Detection has no rule for it. The adapter sends six to
twenty letters and digits. The samples and their sources are in [`numbers.json`](numbers.json).

## Links

`portal.usend.cl/rastrear-shipper/` followed by the guide opens one shipment.

## Testing

`npm run test:carriers:live -- carriers/usend-chile`, with `USEND_CHILE_TRACKING_NUMBER` and
optionally `USEND_CHILE_UNKNOWN_NUMBER` set outside the repository.
