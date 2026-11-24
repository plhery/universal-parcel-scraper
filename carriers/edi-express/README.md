# EDI Express

EDI Express is a less-than-truckload carrier in Gardena, California. Two-driver sleeper teams run
its freight between California, Texas, the Midwest and the East Coast without break-bulk hubs. Its
site is ediexpressinc.com. Tracked through the shipment page its trace form posts a PRO number to.

## How it works

1. `direct`: one `POST https://my.ediexpressinc.com/prodetail.asp` with `p={PRO}&Submit=Trace`, the
   PRO form of the trace page `pro_pu_trace.asp`. No session, token or CAPTCHA.
2. `retry`: one more post after one that fails to connect or hangs. The first gets half of the
   budget.

- A PRO it has no shipment under gets "No data available" in place of the shipment details. The
  notice names no number, so only that page under the details heading reads as not found. A page
  without the heading is a block page or a changed tracker; a redirect or a 404 is a moved route.
- The details name the PRO as the invoice number, which must be the requested one.

## Notes

- Visitors get a summary, not a history: the history needs an account. The result is marked
  `summary_only` and holds the milestones the page dates: the pickup day, the shipment status
  with the day it ends with, the out-for-delivery day and the delivery day. A day's milestones
  follow the order freight reaches them.
- The page gives days only, with no clock or zone, so they stay days in `local_time`.
- A status without a day stands alone only when the page dates no milestone; it cannot be placed
  among dated ones.
- The estimate is the appointment's day once one is made, else the revised estimated delivery day,
  else the first one.
- The total weight in pounds becomes kilograms. The consignee's town and state is
  `receiver_address`, and gives the destination country. The page leaves the parties' names and
  phones empty. The shipper's and bill-to party's towns, the ZIP codes, the terms, the PO number
  and the freight's description and pieces are not read.

## Limitations

- No history, names, signature or proof of delivery; they need an account.
- A PRO reaches the adapter when it is filed under EDI Express or opened from an EDI Express link:
  many carriers use nine digits, so no rule claims them and preflight does not ask it.
- The trace page also takes pickup and quote numbers; the adapter asks by PRO only.

## Numbers

EDI Express PRO numbers are nine digits, the length of the trace form's field and of the public
sample. Many carriers print nine digits, so no rule claims them. The sample and its source are in
[`numbers.json`](numbers.json).

## Links

`my.ediexpressinc.com/prodetail.asp?proNum={PRO}` opens the same shipment details without a
login, as archived links to it show.

## Testing

`npm run test:carriers:live -- carriers/edi-express`, which tracks the public sample unless
`EDI_EXPRESS_TRACKING_NUMBER` is set, and an invented PRO unless `EDI_EXPRESS_UNKNOWN_NUMBER` is.
