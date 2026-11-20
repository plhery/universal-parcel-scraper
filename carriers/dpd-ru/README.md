# DPD Russia

DPD's network in Russia, Belarus and Kazakhstan, which left DPDgroup's systems and keeps its
own order numbers and tracker. Tracked through the search behind its public tracking page.
[DPD Belarus](../dpd-by/README.md) is the same network's catalog entry for Belarus and uses this
adapter.

## How it works

1. `direct`: `POST https://mydpd.dpd.kz/ols/trace2/standard.do2?method:search` with the form
   body `orderNum={number}&orderId=`, as the page's script sends it. No account, key, cookie
   or browser is needed.
2. `retry`: when the Kazakh portal cannot be reached or hangs, the same search on
   `mydpd.dpd.by` is asked once. The first try gets half of the budget.

- The network's Kazakh and Belarusian portals answer for the orders of all three countries.
  `www.dpd.ru` serves the same tracker behind a bot wall, so it is not asked.
- The answer is an HTML fragment: a one-line notice that the tracker holds nothing under the
  number, or the order's current status, its history and its shipment table. It is read only
  when its hidden field and the table's "Номер отправки" show the whole number asked.
- A redirect is a changed search; a 404 or a 410 means it moved; a 403 or a bot check is a
  challenge.
- Recognition makes the same request.

## Notes

- History rows give a day without a clock, oldest first; events carry the day as
  `local_time`. Rows of one day keep the tracker's order.
- The town in parentheses at the end of a wording becomes the event's location.
- A delivered order also lists its parcels with the delivery's wall clock; when that is one
  clock on the day of the last row, the delivery event takes it. Its masked recipient is not
  kept.
- An order that goes on under another order, a return or a new address, ends with "Доставка
  по другому заказу". When the current status names a return number, that event is a return.
- The shipment table's delivery date is the estimate while the order is on its way. Its
  service, weight and destination town are kept; the client's order number and the origin
  town are not.
- The tracker forgets orders after a few months, so an old number reads as not found.

## Limitations

- No clocks before delivery, no zone, no proof of delivery or pickup point.

## Numbers

Orders are RU, BY or KZ and nine digits; the integration guide also shows eleven digits and
eight digits with a terminal's three letters. No rule claims them: two letters and nine digits
are also GLS Italy's layout, so a lookup reaches DPD Russia when the carrier is chosen.

## Links

`mydpd.dpd.kz/ols/trace2/standard.do2?orderNum={number}` opens the tracking page, which fills
its search field from the address and searches on load. Links to `www.dpd.ru` or
`mydpd.dpd.kz` with `orderNum` read as DPD Russia.

## Testing

`npm run test:carriers:live -- carriers/dpd-ru`, with `DPD_RU_TRACKING_NUMBER` and optionally
`DPD_RU_UNKNOWN_NUMBER` set outside the repository.
