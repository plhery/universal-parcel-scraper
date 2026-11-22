# Correos de Guatemala

Select Correos de Guatemala to read the history of a postal item in Guatemala, mostly items sent
to Guatemala from abroad, from the tracker its site links to. Postal detection stays with the
international-mail carrier: no rule or recognition sends item codes here.

## How it works

1. `direct`: posts `tracking={number}` to `http://181.119.103.67/index.php`, the tracker the
   [Correos de Guatemala site](https://correos.gob.gt/) links to. There is no session, captcha or
   account. The tracker answers on plain HTTP at a bare address; no HTTPS name serves it.
2. `retry`: one more try in the rest of the budget when the first request fails to reach the
   server or hangs.

The page shows the item, its origin and destination countries, a status line and dated steps.
It also carries, in an HTML comment, the full history of office scans: IPS event code, the
office's clock to the second, the event, the office and the next office. The adapter reads that
history when it is there in its known shape, and the steps by their day otherwise.

## Notes

- The reply must name the whole item code; another item is indeterminate. Only the tracker's
  own notice for an item it holds nothing for is not found.
- The status line sets the current stage. It names a return that the scans alone show only as a
  dispatch abroad, and a customs hold the newest office transfer does not show.
- The destination country follows the newest dispatch, so on a return it names the country the
  item goes back to. The adapter leaves it out then.
- Scan clocks are Guatemalan office clocks without an offset; they stay wall clocks.

## Limitations

- No expected delivery, weight, service, signatory or proof of delivery is shown.
- The next office in the full history and the origin country are not read.
- The site's tracker is a bare address on plain HTTP and could move without notice.

## Testing

Supply private controls outside Git with `CORREOS_GUATEMALA_TRACKING_NUMBER` and
`CORREOS_GUATEMALA_UNKNOWN_NUMBER`, then run
`npm run test:carriers:live -- carriers/correos-guatemala`.
