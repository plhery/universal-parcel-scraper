# Home Delivery Team

Home Delivery Team (HDT), run by GE Logisztika Kft., delivers online shops' orders across
Hungary, from parcels to appliances and furniture that its two-person crews carry in. Its site
is homedt.hu.

## How it works

`direct` opens `https://homedt.hu/nyomonkovetes?track_number=<order number>`, the page HDT's
search form opens, with no session, token or account; the page loads reCAPTCHA but never asks
for it. The page lists the order's steps oldest first, each with a status title, a time and a
sentence. A page saying the order is not in HDT's system ("Sajnos a keresett megrendelés nem
szerepel rendszerünkben!") is a number HDT does not know; a page without that sentence or any
step is an error, not a missing order. A request that fails to reach the server gets one `retry`
in the rest of the budget.

The status title is each step's code and its sentence the description. The steps keep their wall
clock, which is Budapest's, as the page gives no offset. The only place they name is the central
warehouse in Budapest, which becomes the step's location.

## Numbers

HDT tracks the order number, the last group of digits of the waybill identifier
`XX/YYYY/ZZZZZZ/1234567`, seven digits on today's orders. Digits alone match many other carriers'
numbers, so there is no rule and the carrier needs explicit selection. The page does not repeat
the number it was asked. The samples and their sources are in [`numbers.json`](numbers.json).

## Links

The tracking page opens numbers from its `track_number` parameter, at `/nyomonkovetes` or at the
older `/track` its links still use.

## Limitations

No estimate, weight or proof of delivery. Each icon beside a step names a status number, which the
adapter does not read: the titles already tell the statuses apart.

## Testing

`npm run test:carriers:live -- carriers/home-delivery-team`

The live test tracks the public sample in `numbers.json`; `HOME_DELIVERY_TEAM_TRACKING_NUMBER`
tracks another order, and `HOME_DELIVERY_TEAM_UNKNOWN_NUMBER` checks the not-found answer.
