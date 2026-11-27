# Szendex

Szendex, S.L., of Granollers near Barcelona, is a Spanish courier for same-day and next-day
deliveries, healthcare shipments and logistics in Spain and Europe. It tracks shipments on the
tracker of its ERP, which the tracking page on szendex.com opens.

## How it works

1. `direct`: `GET https://erp.szendex.com/DlWebTrackingVWE/?seg={number}`, the tracker's page for
   one number, with no session or token. The page has the current state, a grid of dated states
   and the shipment's details.
2. `retry`: once more after a network failure or a timeout.

- The only not-found answer is the page's notice "No se ha encontrado el envío solicitado." on a
  page whose form posts back to the number asked. Another notice, a page for another number or a
  page without the tracker's summary is not a missing shipment.
- The tracker also finds a shipment by its sender's reference and then names it by its own number,
  so the page's number must be the one asked. A reference that several shipments carry lists
  them to choose from, which is inconclusive.
- Recognition is off, as no rule offers these numbers.

## Notes

- The JSON route on `www.szendex.com/api/tracking/{number}`, which the site's page asks first,
  gives the state and towns with an empty event list, so the adapter reads the ERP's page.
- Clocks are a day and a time to the minute with no zone. Szendex's network is in peninsular
  Spain and the page gives no place for a state, so each clock keeps its wall clock and is dated
  on Madrid's clock, marked as the carrier's zone.
- The summary's state is the current one. When no rule reads it, the newest state the map knows
  stands.
- A shipment number is its service order, the pickup, followed by six digits. The service order
  has a page of its own, whose states end at the pickup.
- The page states an expected delivery day before a delivery and the delivery's time after it.
- The recipient's name, the towns, the reference, the remarks, the agency's phone, the pickup's
  map link and the delivery note image are not read. The page's view state holds the address and
  the sender, and is not read either.

## Limitations

- No page for a shipment still on its way has been seen. The expected delivery day is read from
  the summary row labelled "Fecha prevista de Entrega", the label the page's view state carries.
- The grid's description column is empty in the replies seen and is not read, nor the type of
  incident the details show.

## Numbers

The tracker takes up to 30 characters, and szendex.com's form asks for at least six. The one
public number is eighteen digits, a shape other carriers' numbers share, so there is no rule and
the carrier is asked only when it is selected or a link names it.

## Links

`erp.szendex.com/DlWebTrackingVWE/?seg={number}` opens one shipment on the tracker, and the
library reads the number from `seg`.

## Testing

`npm run test:carriers:live -- carriers/szendex`, with `SZENDEX_TRACKING_NUMBER` and
`SZENDEX_UNKNOWN_NUMBER` optionally set.
