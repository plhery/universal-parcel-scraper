# Southwestern Motor Transport

Southwestern Motor Transport (SMT Lines) is a less-than-truckload freight carrier based in San
Antonio, Texas. Its site is smtl.com. The adapter traces a PRO on SMT's Shipment Tracing screen.

## How it works

1. `direct`: SMT's Shipment Tracing page is a Profound UI program on profoundui.smtl.com, open
   without an account, cookie or CAPTCHA. A form post of `program=MWP705C&library=PROFOUNDUI&init=1`
   to `/profoundui/PUI0001200.pgm` opens a session and returns the trace screen as JSON with its
   session id. A post of `TRACEBY.FHPRO` (the PRO) and `TRACEBY.TABINDEX=0` to that path followed
   by the session id traces the PRO and returns the screen with the shipment. A last post of
   `shutdown=1`, which the page sends when it closes, ends the session, which the server would
   otherwise keep for fifteen minutes.
2. `retry`: one more try, on a new session, after a lookup that fails to connect or hangs. The
   first try gets half of the budget.

- The screen's PRO must be the PRO asked.
- A PRO the trace does not find clears the entry and shows the empty screen without a message.
  That proves nothing, so it is inconclusive rather than not found. A screen other than the trace,
  a reply that did not run, a block page and a changed reply keep their own failure kinds.
- The screen also traces by interline PRO, bill of lading, purchase order or pickup number. The
  adapter sends whole SMT PROs only.

## Notes

- Each trace row has a town, a day, a status and a time. Clocks carry no zone and SMT runs across
  more than one time zone, so they stay local times. A row without a time keeps its day.
- The row after a delivery gives the signer's name where the others give the town, and is left
  out. The summary line, which repeats the signer, is not read.
- The status line above the rows settles a delivery. Otherwise the newest staged row leads, and
  the status line stands in when no row has a stage.
- The estimate is the delivery appointment's day, else the due day. It is dropped once it is
  behind the history or the freight is delivered.
- The weight is given in pounds and kept in kilograms.
- The bill of lading, the purchase order, the handling units and pieces, the towns of the shipper
  and consignee, the delivery's day and time on the summary and the delivery images are not read.

## Limitations

- No offsets, no sender, recipient or signer, and no proof of delivery.
- An unknown PRO is never reported as not found.
- A PRO reaches the adapter when it is filed under SMT: its digits are shared by many carriers, so
  no rule claims them and preflight does not ask it.

## Numbers

SMT's entry field takes a PRO of up to eleven digits and the trace reads it as a number, so the
adapter takes six to eleven digits and drops leading zeros. The samples and their sources are in
[`numbers.json`](numbers.json).

## Links

No tracking link is known: the screen has no page or address per number.

## Testing

`npm run test:carriers:live -- carriers/southwestern-motor-transport`, with
`SOUTHWESTERN_MOTOR_TRANSPORT_TRACKING_NUMBER` optionally set outside the repository.
