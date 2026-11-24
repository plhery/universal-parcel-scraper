# Ross Express

Ross Express is a New England less-than-truckload carrier based in New Hampshire, majority owned
by [PITT OHIO](../pitt-ohio/README.md) and run under its own name. Its site is rossexpress.com. The
adapter reads a PRO from Ross's XML trace on Carrier Logistics.

## How it works

1. `direct`: Ross's Quick Trace form opens its tracker on Carrier Logistics. The same host gives
   `tracking.carrierlogistics.com/scripts/rxic.pol/protracexml.htm?pronum=<PRO>` as XML without a
   login, cookie or CAPTCHA, as [Dohrn Transfer](../dohrn-transfer/README.md)'s trace does.
2. `retry`: one more read after a lookup that fails to connect or hangs. The first try gets half of
   the budget.

- An error document reading `Invalid pronumber <PRO>` for the PRO asked is the only not-found.
- The reply's PRO must be the PRO asked. A number the trace does not hold as a PRO can match
  another shipment's reference, which is inconclusive.
- A rate quote shares the numbers with shipments and is inconclusive. Six- and seven-digit numbers
  are densely used, so an invented one usually finds someone else's bill or quote.
- A WebSpeed error page, a block page, a redirect, a missing route and a changed reply keep their
  own failure kinds.

## Notes

- Each history row has a wording, a day, a 24-hour time and a remark. Clocks carry no zone, so
  they stay local times. A row without a time keeps its day.
- The remark is kept as the location when it is a town and state. A Ross terminal is written
  "Ross Auburn, MA" and keeps its town.
- A delivery on the lifecycle above the rows settles the stage. Otherwise the newest staged row
  leads.
- The weight is given in pounds and kept in kilograms.
- The bill and purchase order numbers, the towns and ZIP codes of the shipper and consignee, the
  terminals, the pieces and the delivery's clock, status line and signer are not read.

## Limitations

- No offsets, no estimate, no sender, recipient or signer.
- A PRO reaches the adapter when it is filed under Ross Express: seven digits are a length many
  carriers share, so no rule claims them and preflight does not ask it.

## Numbers

The Quick Trace form takes a PRO of up to seven digits. The adapter takes six or seven digits as
typed. The samples and their sources are in [`numbers.json`](numbers.json).

## Links

The tracker's shipment page opens a PRO number from its `wpro1` parameter, and its entry page
from `pronum`.

## Testing

`npm run test:carriers:live -- carriers/ross-express`, with `ROSS_EXPRESS_TRACKING_NUMBER`
optionally set outside the repository.
